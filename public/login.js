const form = document.getElementById('login-form');
const errorMessage = document.getElementById('error-message');
const loginButton = document.getElementById('login-button');
const loadingOverlay = document.getElementById('loading-overlay');
const errorModal = document.getElementById('error-modal');
const errorModalTitle = document.getElementById('error-modal-title');
const errorModalMessage = document.getElementById('error-modal-message');
const errorModalClose = document.getElementById('error-modal-close');

let activeConnectionTest = null;
const CONNECTION_TEST_TIMEOUT_MS = 15000;
const CONNECTION_STABILITY_MS = 3000;

function showLoading() {
    loadingOverlay.classList.add('active');
    loginButton.disabled = true;
}

function hideLoading() {
    loadingOverlay.classList.remove('active');
    loginButton.disabled = false;
}

function showErrorPopup(title, message) {
    errorModalTitle.textContent = title;
    errorModalMessage.textContent = message;
    errorModal.classList.add('active');
}

function hideErrorPopup() {
    errorModal.classList.remove('active');
}

function buildWebSocketUrl() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${location.host}/`;
}

function buildTokenUrl(mode = 'viewer') {
    const width = Math.max(640, Math.round(window.innerWidth || 1366));
    const height = Math.max(480, Math.round(window.innerHeight || 768));
    const dpi = Math.max(96, Math.min(384, Math.round((window.devicePixelRatio || 1) * 96)));
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const params = new URLSearchParams({
        width: String(width),
        height: String(height),
        dpi: String(dpi),
        mode
    });

    if (timezone) {
        params.set('timezone', timezone);
    }

    return `/api/guacamole-token?${params.toString()}`;
}

function mapConnectionError(error) {
    if (!error) {
        return 'Unable to validate the RDP connection.';
    }

    if (error.validationDisconnected) {
        return 'The remote desktop disconnected before login validation completed. Please verify the password and try again.';
    }

    const code = error.code;
    if (
        code === Guacamole.Status.Code.CLIENT_UNAUTHORIZED
        || code === Guacamole.Status.Code.UPSTREAM_UNAUTHORIZED
        || code === Guacamole.Status.Code.CLIENT_FORBIDDEN
        || code === Guacamole.Status.Code.UPSTREAM_FORBIDDEN
    ) {
        return 'Access denied. Please verify the RDP username and password.';
    }

    if (code === Guacamole.Status.Code.UPSTREAM_NOT_FOUND) {
        return 'The remote RDP host could not be reached.';
    }

    if (code === Guacamole.Status.Code.UPSTREAM_UNAVAILABLE) {
        return 'The RDP service is unavailable right now.';
    }

    return error.message || 'Unable to validate the RDP connection.';
}

async function clearFailedSession() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (_error) {
    }
}

function cleanupConnectionTest(testState) {
    if (!testState || testState.cleaned) {
        return;
    }

    testState.cleaned = true;
    window.clearTimeout(testState.timeoutId);
    window.clearTimeout(testState.stabilityTimerId);

    if (testState.client) {
        try {
            testState.client.disconnect();
        } catch (_error) {
        }
    }

    if (testState.host?.parentNode) {
        testState.host.parentNode.removeChild(testState.host);
    }
}

function testConnection(tokenData) {
    return new Promise((resolve, reject) => {
        const host = document.createElement('div');
        host.style.position = 'fixed';
        host.style.width = '1px';
        host.style.height = '1px';
        host.style.opacity = '0';
        host.style.pointerEvents = 'none';
        host.style.left = '-9999px';
        host.style.top = '0';
        document.body.appendChild(host);

        const tunnel = new Guacamole.WebSocketTunnel(buildWebSocketUrl());
        const client = new Guacamole.Client(tunnel);

        const testState = {
            client,
            host,
            cleaned: false,
            resolved: false,
            timeoutId: 0,
            stabilityTimerId: 0,
            connected: false
        };

        activeConnectionTest = testState;
        host.appendChild(client.getDisplay().getElement());

        const finishSuccess = () => {
            if (testState.resolved) {
                return;
            }

            testState.resolved = true;
            cleanupConnectionTest(testState);
            if (activeConnectionTest === testState) {
                activeConnectionTest = null;
            }
            resolve();
        };

        const finishError = (error) => {
            if (testState.resolved) {
                return;
            }

            testState.resolved = true;
            cleanupConnectionTest(testState);
            if (activeConnectionTest === testState) {
                activeConnectionTest = null;
            }
            reject(error);
        };

        testState.timeoutId = window.setTimeout(() => {
            finishError(new Error('Connection timed out while validating RDP access.'));
        }, CONNECTION_TEST_TIMEOUT_MS);

        client.onerror = (error) => {
            finishError(error);
        };

        client.onstatechange = (state) => {
            if (state === Guacamole.Client.State.CONNECTED) {
                if (testState.connected) {
                    return;
                }

                testState.connected = true;
                testState.stabilityTimerId = window.setTimeout(() => {
                    finishSuccess();
                }, CONNECTION_STABILITY_MS);
                return;
            }

            if (state === Guacamole.Client.State.DISCONNECTED) {
                const disconnectError = new Error(
                    testState.connected
                        ? 'The remote desktop disconnected before login validation completed.'
                        : 'The remote desktop disconnected while validating the login.'
                );
                disconnectError.validationDisconnected = testState.connected;
                finishError(disconnectError);
            }
        };

        try {
            client.connect(`token=${encodeURIComponent(tokenData.token)}`);
        } catch (error) {
            finishError(error);
        }
    });
}

errorModalClose.addEventListener('click', hideErrorPopup);

errorModal.addEventListener('click', (event) => {
    if (event.target === errorModal) {
        hideErrorPopup();
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && errorModal.classList.contains('active')) {
        hideErrorPopup();
    }
});

window.addEventListener('beforeunload', () => {
    cleanupConnectionTest(activeConnectionTest);
    activeConnectionTest = null;
});

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideErrorPopup();
    errorMessage.hidden = true;

    const formData = new FormData(form);
    const payload = {
        username: String(formData.get('username') || '').trim(),
        password: String(formData.get('password') || '')
    };

    if (!payload.username || !payload.password) {
        errorMessage.textContent = 'Username and password are required.';
        errorMessage.hidden = false;
        return;
    }

    showLoading();

    try {
        const loginResponse = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const loginData = await loginResponse.json();
        if (!loginResponse.ok) {
            throw new Error(loginData.error || 'Login failed');
        }

        const tokenResponse = await fetch(buildTokenUrl('validate'));
        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            throw new Error(tokenData.error || 'Unable to create RDP session');
        }

        await testConnection(tokenData);

        const confirmResponse = await fetch('/api/login/confirm', {
            method: 'POST'
        });
        const confirmData = await confirmResponse.json();

        if (!confirmResponse.ok) {
            throw new Error(confirmData.error || 'Unable to finalize the RDP login.');
        }

        window.location.href = confirmData.redirectTo || loginData.redirectTo || '/rdp';
    } catch (error) {
        await clearFailedSession();
        hideLoading();
        showErrorPopup('Connection Failed', mapConnectionError(error));
    }
});

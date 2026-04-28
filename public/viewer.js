const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayMessage = document.getElementById('overlay-message');
const backLink = document.getElementById('back-link');
const statusText = document.getElementById('status-text');
const viewerTitle = document.getElementById('viewer-title');
const display = document.getElementById('display');
const logoutButton = document.getElementById('logout-button');
const uiToggle = document.getElementById('ui-toggle');
const reconnectButton = document.getElementById('reconnect-button');
const overlayLogoutButton = document.getElementById('overlay-logout-button');
const overlayActions = document.getElementById('overlay-actions');
const infoPanel = document.getElementById('info-panel');

let client = null;
let mouse = null;
let keyboard = null;
let clientState = Guacamole.Client.State.IDLE;
let connecting = false;
let connectedStatus = 'Preparing session...';
let resizeTimer = 0;
let statusResetTimer = 0;
let lastRequestedSizeKey = '';
let clipboardFallbackInput = null;
let audioUnlockBound = false;
let microphoneRecorder = null;
let microphoneStreamIndex = null;
let microphoneStartAttempted = false;
let sessionCapabilities = null;
let clipboardPasteTimer = 0;

function getAudioContext() {
    try {
        return Guacamole.AudioContextFactory?.getAudioContext?.() || null;
    } catch (_error) {
        return null;
    }
}

function resumeAudioContext() {
    const audioContext = getAudioContext();

    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {
        });
    }
}

function bindAudioUnlock() {
    if (audioUnlockBound) {
        return;
    }

    const unlockAudio = () => {
        resumeAudioContext();

        if (client && sessionCapabilities) {
            ensureMicrophoneCapture(client, sessionCapabilities);
        }
    };

    ['pointerdown', 'touchstart', 'keydown'].forEach((eventName) => {
        window.addEventListener(eventName, unlockAudio, { passive: true });
    });

    audioUnlockBound = true;
}

function getSupportedAudioOutputTypes() {
    const supportedTypes = Guacamole.AudioPlayer?.getSupportedTypes?.() || [];
    const ordered = [];

    ['audio/L16', 'audio/L8'].forEach((type) => {
        if (supportedTypes.includes(type) && !ordered.includes(type)) {
            ordered.push(type);
        }
    });

    supportedTypes.forEach((type) => {
        if (!ordered.includes(type)) {
            ordered.push(type);
        }
    });

    return ordered;
}

function getSupportedMicrophoneTypes() {
    const supportedTypes = Guacamole.AudioRecorder?.getSupportedTypes?.() || [];
    const ordered = [];

    ['audio/L16', 'audio/L8'].forEach((type) => {
        if (supportedTypes.includes(type) && !ordered.includes(type)) {
            ordered.push(type);
        }
    });

    supportedTypes.forEach((type) => {
        if (!ordered.includes(type)) {
            ordered.push(type);
        }
    });

    return ordered;
}

function negotiateAudioTypes(tokenData) {
    const browserTypes = getSupportedAudioOutputTypes();

    if (!browserTypes.length) {
        return [];
    }

    const configuredTypes = Array.isArray(tokenData?.audioTypes)
        ? tokenData.audioTypes.filter((type) => typeof type === 'string' && type.trim())
        : [];

    if (!configuredTypes.length) {
        return browserTypes;
    }

    const browserTypeSet = new Set(browserTypes);
    const negotiatedTypes = configuredTypes.filter((type) => browserTypeSet.has(type));

    return negotiatedTypes.length ? negotiatedTypes : browserTypes;
}

function buildDefaultMicrophoneMimetype(baseType = 'audio/L16') {
    return `${baseType};rate=44100,channels=2`;
}

function pickMicrophoneMimetype(tokenData) {
    const configuredMimetype = typeof tokenData?.microphoneMimetype === 'string'
        ? tokenData.microphoneMimetype.trim()
        : '';

    if (configuredMimetype && Guacamole.AudioRecorder?.isSupportedType?.(configuredMimetype)) {
        return configuredMimetype;
    }

    const supportedTypes = getSupportedMicrophoneTypes();
    const preferredBaseType = supportedTypes.includes('audio/L16')
        ? 'audio/L16'
        : supportedTypes[0];

    if (!preferredBaseType) {
        return '';
    }

    return buildDefaultMicrophoneMimetype(preferredBaseType);
}

function buildConnectQuery(tokenData) {
    const params = new URLSearchParams();
    params.set('token', tokenData.token);

    negotiateAudioTypes(tokenData).forEach((type) => {
        params.append('audio', type);
    });

    return params.toString();
}

function resetMicrophoneState(activeClient = client, shouldEndStream = false) {
    if (shouldEndStream && activeClient && microphoneStreamIndex !== null) {
        try {
            activeClient.endStream(microphoneStreamIndex);
        } catch (_error) {
        }
    }

    microphoneRecorder = null;
    microphoneStreamIndex = null;
    microphoneStartAttempted = false;
}

function ensureMicrophoneCapture(activeClient, tokenData) {
    if (
        client !== activeClient
        || !isConnected()
        || microphoneStartAttempted
        || microphoneRecorder
        || tokenData?.validationOnly
    ) {
        return;
    }

    const microphoneMimetype = pickMicrophoneMimetype(tokenData);

    if (!microphoneMimetype) {
        microphoneStartAttempted = true;
        setTemporaryStatus('Browser does not support microphone redirection', 3200);
        return;
    }

    microphoneStartAttempted = true;

    try {
        const stream = activeClient.createAudioStream(microphoneMimetype);
        const recorder = Guacamole.AudioRecorder.getInstance(stream, microphoneMimetype);

        if (!recorder) {
            activeClient.endStream(stream.index);
            setTemporaryStatus('Microphone redirection is unavailable in this browser', 3200);
            return;
        }

        microphoneRecorder = recorder;
        microphoneStreamIndex = stream.index;
        setTemporaryStatus('Starting microphone redirection...', 2200);

        recorder.onclose = () => {
            if (client !== activeClient) {
                return;
            }

            microphoneRecorder = null;
            microphoneStreamIndex = null;
        };

        recorder.onerror = () => {
            if (client !== activeClient) {
                return;
            }

            microphoneRecorder = null;
            microphoneStreamIndex = null;
            setTemporaryStatus('Microphone redirection unavailable or denied', 3600);
        };
    } catch (error) {
        microphoneRecorder = null;
        microphoneStreamIndex = null;
        setTemporaryStatus(error.message || 'Unable to start microphone redirection', 3600);
    }
}

function isConnected() {
    return Boolean(
        client
        && (
            clientState === Guacamole.Client.State.CONNECTED
            || clientState === Guacamole.Client.State.WAITING
        )
    );
}

function setOverlay(title, message, showBackLink = false, showReconnect = false, showLogout = false) {
    overlayTitle.textContent = title;
    overlayMessage.textContent = message;
    backLink.hidden = !showBackLink;
    reconnectButton.hidden = !showReconnect;
    overlayLogoutButton.hidden = !showLogout;
    overlayActions.hidden = !(showBackLink || showReconnect || showLogout);
    overlay.classList.remove('hidden');
}

function hideOverlay() {
    overlay.classList.add('hidden');
}

function buildWebSocketUrl() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${location.host}/`;
}

function buildConnectedStatus(host, port) {
    return `Connected to ${host}:${port}`;
}

function setTemporaryStatus(message, timeoutMs = 1800) {
    window.clearTimeout(statusResetTimer);
    statusText.textContent = message;

    if (!isConnected()) {
        return;
    }

    statusResetTimer = window.setTimeout(() => {
        if (isConnected()) {
            statusText.textContent = connectedStatus;
        }
    }, timeoutMs);
}

function getViewportMetrics() {
    const rect = display.getBoundingClientRect();
    const width = Math.max(640, Math.round(rect.width || window.innerWidth || 1366));
    const height = Math.max(480, Math.round(rect.height || window.innerHeight || 768));
    const dpi = Math.max(96, Math.min(384, Math.round((window.devicePixelRatio || 1) * 96)));
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

    return { width, height, dpi, timezone };
}

function buildTokenUrl() {
    const { width, height, dpi, timezone } = getViewportMetrics();
    const params = new URLSearchParams({
        width: String(width),
        height: String(height),
        dpi: String(dpi)
    });

    if (timezone) {
        params.set('timezone', timezone);
    }

    return `/api/guacamole-token?${params.toString()}`;
}

function updateDisplayScale() {
    if (!client) {
        return;
    }

    const guacDisplay = client.getDisplay();
    const remoteWidth = guacDisplay.getWidth();
    const remoteHeight = guacDisplay.getHeight();
    const rect = display.getBoundingClientRect();

    if (!remoteWidth || !remoteHeight || !rect.width || !rect.height) {
        return;
    }

    const scale = Math.min(rect.width / remoteWidth, rect.height / remoteHeight);
    guacDisplay.scale(scale > 0 ? scale : 1);
}

function requestRemoteResize(force = false) {
    updateDisplayScale();

    if (!isConnected()) {
        return;
    }

    const { width, height } = getViewportMetrics();
    const sizeKey = `${width}x${height}`;

    if (!force && sizeKey === lastRequestedSizeKey) {
        return;
    }

    lastRequestedSizeKey = sizeKey;
    client.sendSize(width, height);
}

function scheduleRemoteResize(force = false) {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        requestRemoteResize(force);
    }, 120);
}

function ensureClipboardFallbackInput() {
    if (clipboardFallbackInput) {
        return clipboardFallbackInput;
    }

    clipboardFallbackInput = document.createElement('textarea');
    clipboardFallbackInput.setAttribute('aria-hidden', 'true');
    clipboardFallbackInput.tabIndex = -1;
    clipboardFallbackInput.style.position = 'fixed';
    clipboardFallbackInput.style.opacity = '0';
    clipboardFallbackInput.style.pointerEvents = 'none';
    clipboardFallbackInput.style.left = '-9999px';
    clipboardFallbackInput.style.top = '0';
    document.body.appendChild(clipboardFallbackInput);
    return clipboardFallbackInput;
}

function fallbackCopyToClipboard(text) {
    const input = ensureClipboardFallbackInput();
    input.value = text;
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);

    let copied = false;

    try {
        copied = document.execCommand('copy');
    } catch (_error) {
        copied = false;
    }

    input.blur();
    window.getSelection()?.removeAllRanges();
    return copied;
}

async function copyToLocalClipboard(text) {
    if (!text) {
        return false;
    }

    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_error) {
    }

    return fallbackCopyToClipboard(text);
}

function sendClipboardTextToRemote(text) {
    if (!isConnected() || !text) {
        return;
    }

    const stream = client.createClipboardStream('text/plain');
    const writer = new Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
    setTemporaryStatus('Clipboard pasted into remote session');
}

function sendRemoteKeyTap(keysym) {
    if (!isConnected()) {
        return;
    }

    client.sendKeyEvent(1, keysym);
    client.sendKeyEvent(0, keysym);
}

function sendRemoteKeyChord(modifierKeysym, keyKeysym) {
    if (!isConnected()) {
        return;
    }

    client.sendKeyEvent(1, modifierKeysym);
    client.sendKeyEvent(1, keyKeysym);
    client.sendKeyEvent(0, keyKeysym);
    client.sendKeyEvent(0, modifierKeysym);
}

function triggerRemotePasteShortcut(shortcutType) {
    window.clearTimeout(clipboardPasteTimer);
    clipboardPasteTimer = window.setTimeout(() => {
        if (!isConnected()) {
            return;
        }

        if (shortcutType === 'shift-insert') {
            sendRemoteKeyChord(0xFFE1, 0xFF63);
            return;
        }

        sendRemoteKeyChord(0xFFE3, 0x0076);
    }, 60);
}

async function readLocalClipboardText() {
    if (!navigator.clipboard?.readText) {
        throw new Error('Browser blocked clipboard read');
    }

    return navigator.clipboard.readText();
}

async function syncLocalClipboardToRemote(shortcutType = '') {
    if (!isConnected()) {
        return false;
    }

    const text = await readLocalClipboardText();

    if (!text) {
        return false;
    }

    sendClipboardTextToRemote(text);

    if (shortcutType) {
        triggerRemotePasteShortcut(shortcutType);
    }

    return true;
}

function handlePaste(event) {
    if (!isConnected()) {
        return;
    }

    const text = event.clipboardData?.getData('text/plain');

    if (text) {
        event.preventDefault();
        sendClipboardTextToRemote(text);
        triggerRemotePasteShortcut('ctrl-v');
        return;
    }

    if (navigator.clipboard?.readText) {
        event.preventDefault();
        syncLocalClipboardToRemote('ctrl-v')
            .catch((error) => {
                console.error('Unable to read local clipboard:', error);
                setTemporaryStatus('Browser blocked clipboard read');
            });
    }
}

function handleClipboardShortcut(event) {
    if (!isConnected()) {
        return;
    }

    const key = String(event.key || '').toLowerCase();
    const isCtrlLikePaste = (event.ctrlKey || event.metaKey) && !event.altKey && key === 'v';
    const isShiftInsertPaste = event.shiftKey && !event.ctrlKey && !event.metaKey && key === 'insert';

    if (!isCtrlLikePaste && !isShiftInsertPaste) {
        return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    syncLocalClipboardToRemote(isShiftInsertPaste ? 'shift-insert' : 'ctrl-v')
        .catch((error) => {
            console.error('Unable to sync local clipboard to remote:', error);
            setTemporaryStatus(error.message || 'Browser blocked clipboard read', 3200);
        });
}

function cleanupClient() {
    window.clearTimeout(resizeTimer);
    window.clearTimeout(statusResetTimer);
    window.clearTimeout(clipboardPasteTimer);
    const activeClient = client;
    const shouldEndMicrophoneStream = Boolean(
        activeClient
        && microphoneStreamIndex !== null
        && (
            clientState === Guacamole.Client.State.CONNECTED
            || clientState === Guacamole.Client.State.WAITING
        )
    );
    lastRequestedSizeKey = '';
    clientState = Guacamole.Client.State.IDLE;
    sessionCapabilities = null;

    if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        keyboard.reset();
        keyboard = null;
    }

    mouse = null;

    client = null;

    resetMicrophoneState(activeClient, shouldEndMicrophoneStream);

    if (activeClient) {
        try {
            activeClient.disconnect();
        } catch (_error) {
        }
    }

    display.replaceChildren();
}

async function logout() {
    cleanupClient();
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
}

function handleReconnect() {
    cleanupClient();
    setOverlay('Restarting session', 'Reconnecting to the remote desktop...');
    window.setTimeout(() => {
        startViewer();
    }, 300);
}

async function startViewer() {
    if (connecting) {
        return;
    }

    connecting = true;
    cleanupClient();
    setOverlay('Starting RDP session', 'Please wait while the browser connects to the remote desktop.');

    try {
        const sessionResponse = await fetch('/api/session');
        const sessionData = await sessionResponse.json();

        if (!sessionData.authenticated) {
            window.location.href = '/login';
            return;
        }

        viewerTitle.textContent = `${sessionData.targetHost} as ${sessionData.username}`;
        statusText.textContent = 'Requesting secure session token...';

        const tokenResponse = await fetch(buildTokenUrl());
        const tokenData = await tokenResponse.json();

        if (!tokenResponse.ok) {
            throw new Error(tokenData.error || 'Unable to create RDP session');
        }

        statusText.textContent = 'Connecting to guacd...';

        const tunnel = new Guacamole.WebSocketTunnel(buildWebSocketUrl());
        const activeClient = new Guacamole.Client(tunnel);
        client = activeClient;
        clientState = Guacamole.Client.State.IDLE;
        sessionCapabilities = tokenData;

        const displayElement = activeClient.getDisplay().getElement();
        displayElement.classList.add('guac-display-host');
        display.replaceChildren(displayElement);

        connectedStatus = buildConnectedStatus(tokenData.targetHost, tokenData.targetPort);
        bindAudioUnlock();
        resumeAudioContext();

        activeClient.getDisplay().onresize = () => {
            if (client !== activeClient) {
                return;
            }

            updateDisplayScale();
        };

        mouse = new Guacamole.Mouse(displayElement);
        mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (event) => {
            if (client !== activeClient || !isConnected()) {
                return;
            }

            activeClient.sendMouseState(event.state, true);
        });
        mouse.on('mouseout', () => {
            if (client === activeClient) {
                activeClient.getDisplay().showCursor(false);
            }
        });

        activeClient.getDisplay().oncursor = (canvas, x, y) => {
            if (client !== activeClient || !mouse) {
                return;
            }

            const usingNativeCursor = mouse.setCursor(canvas, x, y);
            activeClient.getDisplay().showCursor(!usingNativeCursor);
        };

        keyboard = new Guacamole.Keyboard(window);
        keyboard.onkeydown = (keysym) => {
            if (client === activeClient && isConnected()) {
                activeClient.sendKeyEvent(1, keysym);
            }
        };
        keyboard.onkeyup = (keysym) => {
            if (client === activeClient && isConnected()) {
                activeClient.sendKeyEvent(0, keysym);
            }
        };

        activeClient.onclipboard = (stream, mimetype) => {
            if (client !== activeClient || !/^text\//i.test(mimetype)) {
                return;
            }

            const reader = new Guacamole.StringReader(stream);
            let text = '';
            statusText.textContent = 'Receiving clipboard data...';

            reader.ontext = (chunk) => {
                text += chunk;
            };

            reader.onend = async () => {
                if (client !== activeClient) {
                    return;
                }

                const copied = await copyToLocalClipboard(text);
                setTemporaryStatus(
                    copied
                        ? 'Clipboard synced from remote session'
                        : 'Remote clipboard received, but the browser blocked automatic copy',
                    copied ? 1800 : 3200
                );
            };
        };

        activeClient.onaudio = (stream, mimetype) => {
            resumeAudioContext();

            const audioPlayer = Guacamole.AudioPlayer.getInstance(stream, mimetype);

            if (!audioPlayer) {
                setTemporaryStatus(`Unsupported audio stream: ${mimetype}`, 3600);
            }

            return audioPlayer;
        };

        activeClient.onerror = (error) => {
            if (client !== activeClient) {
                return;
            }

            connecting = false;

            let message = error.message || 'An unexpected RDP error occurred.';
            if (
                error.code === Guacamole.Status.Code.CLIENT_UNAUTHORIZED
                || error.code === Guacamole.Status.Code.UPSTREAM_UNAUTHORIZED
            ) {
                message = 'Access denied. Please verify the RDP username and password.';
            }

            statusText.textContent = 'Connection error occurred';
            setOverlay('Connection Failed', message, false, true, true);
        };

        activeClient.onstatechange = (state) => {
            if (client !== activeClient) {
                return;
            }

            clientState = state;

            if (state === Guacamole.Client.State.CONNECTED) {
                connecting = false;
                statusText.textContent = connectedStatus;
                hideOverlay();
                scheduleRemoteResize(true);

                if (tokenData.microphoneMimetype || negotiateAudioTypes(tokenData).length) {
                    setTemporaryStatus('Click or press a key once to enable audio and microphone', 3200);
                }

                return;
            }

            if (state === Guacamole.Client.State.DISCONNECTED) {
                connecting = false;
                statusText.textContent = 'Disconnected';
                setOverlay(
                    'Session Ended',
                    'The remote session was closed. You can reconnect or logout.',
                    false,
                    true,
                    true
                );
            }
        };

        clientState = Guacamole.Client.State.CONNECTING;
        activeClient.connect(buildConnectQuery(tokenData));
    } catch (error) {
        connecting = false;
        statusText.textContent = 'Startup failed';
        setOverlay(
            'Unable to start session',
            error.message || 'An unexpected error occurred during session startup.',
            false,
            true,
            true
        );
    }
}

uiToggle.addEventListener('click', () => {
    infoPanel.classList.toggle('active');
});

reconnectButton.addEventListener('click', handleReconnect);
overlayLogoutButton.addEventListener('click', logout);
logoutButton.addEventListener('click', logout);

window.addEventListener('resize', () => {
    scheduleRemoteResize();
});

window.visualViewport?.addEventListener('resize', () => {
    scheduleRemoteResize();
});

window.addEventListener('paste', handlePaste);
window.addEventListener('keydown', handleClipboardShortcut, true);

window.addEventListener('beforeunload', () => {
    cleanupClient();
});

startViewer();

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
const targetHostInput = document.getElementById('target-host');
const targetPortInput = document.getElementById('target-port');
const connectTargetButton = document.getElementById('connect-target');
// Note: paste UI removed to allow native copy/paste behavior

const CONTROL_LEFT_KEYSYM = 0xFFE3;
const INSERT_KEYSYM = 0xFF63;
const V_KEYSYM = 0x0076;

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
let clipboardBridgeInput = null;
let clipboardPasteFallbackTimer = 0;
let pendingPasteShortcut = null;
let suppressedPasteKey = '';
let audioUnlockBound = false;
let microphoneRecorder = null;
let microphoneStreamIndex = null;
let microphoneStartAttempted = false;
let sessionCapabilities = null;
let lastRemoteClipboardText = '';

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

    // Allow overriding target host/port via UI inputs. Server may accept these query params.
    const host = targetHostInput?.value?.trim();
    const port = targetPortInput?.value?.trim();

    if (host) params.set('targetHost', host);
    if (port) params.set('targetPort', port);

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

function ensureClipboardBridgeInput() {
    if (clipboardBridgeInput) {
        return clipboardBridgeInput;
    }

    clipboardBridgeInput = document.createElement('textarea');
    clipboardBridgeInput.setAttribute('aria-hidden', 'true');
    clipboardBridgeInput.setAttribute('autocomplete', 'off');
    clipboardBridgeInput.setAttribute('autocapitalize', 'off');
    clipboardBridgeInput.setAttribute('autocorrect', 'off');
    clipboardBridgeInput.setAttribute('spellcheck', 'false');
    clipboardBridgeInput.tabIndex = -1;
    clipboardBridgeInput.style.position = 'fixed';
    clipboardBridgeInput.style.opacity = '0';
    clipboardBridgeInput.style.pointerEvents = 'none';
    clipboardBridgeInput.style.left = '-9999px';
    clipboardBridgeInput.style.top = '0';
    clipboardBridgeInput.style.width = '1px';
    clipboardBridgeInput.style.height = '1px';
    clipboardBridgeInput.style.padding = '0';
    clipboardBridgeInput.style.border = '0';
    clipboardBridgeInput.style.resize = 'none';
    clipboardBridgeInput.value = '';
    clipboardBridgeInput.addEventListener('input', () => {
        clipboardBridgeInput.value = '';
    });
    document.body.appendChild(clipboardBridgeInput);
    return clipboardBridgeInput;
}

function focusClipboardBridge() {
    if (!isConnected() || !overlay.classList.contains('hidden')) {
        return;
    }

    const bridge = ensureClipboardBridgeInput();

    try {
        bridge.focus({ preventScroll: true });
        bridge.select();
        bridge.setSelectionRange(0, bridge.value.length);
    } catch (_error) {
    }
}

function blurClipboardBridge() {
    if (!clipboardBridgeInput || document.activeElement !== clipboardBridgeInput) {
        return;
    }

    clipboardBridgeInput.blur();
}

function isLocalEditableElement(element) {
    return Boolean(
        element
        && element !== clipboardBridgeInput
        && (
            element.matches?.('input, textarea, select')
            || element.isContentEditable
        )
    );
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

function sendRemotePasteGesture(shortcutType = '') {
    if (!isConnected()) {
        return;
    }

    if (shortcutType === 'shift-insert') {
        sendRemoteKeyTap(INSERT_KEYSYM);
        return;
    }

    if (shortcutType === 'ctrl-v') {
        sendRemoteKeyTap(V_KEYSYM);
        return;
    }

    sendRemoteKeyChord(CONTROL_LEFT_KEYSYM, V_KEYSYM);
}

function pasteTextIntoRemote(text, shortcutType = '') {
    if (!text) {
        setTemporaryStatus('Local clipboard is empty', 1400);
        return false;
    }

    sendClipboardTextToRemote(text);
    sendRemotePasteGesture(shortcutType);
    return true;
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

// Clipboard sync prefers real browser paste gestures, then mirrors those into
// the remote session using Guacamole clipboard streams and a matching key chord.

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

    return pasteTextIntoRemote(text, shortcutType);
}

function handlePaste(event) {
    if (!isConnected()) {
        return;
    }

    const activeElement = document.activeElement;
    const target = event.target;
    const targetIsBridge = target === clipboardBridgeInput;

    if (!targetIsBridge && isLocalEditableElement(activeElement)) {
        return;
    }

    const text = event.clipboardData?.getData('text/plain') || '';

    if (!text) {
        return;
    }

    event.preventDefault();
    const shortcutType = pendingPasteShortcut?.type || '';
    window.clearTimeout(clipboardPasteFallbackTimer);
    pendingPasteShortcut = null;
    pasteTextIntoRemote(text, shortcutType);
}

function handleClipboardShortcut(event) {
    if (!isConnected()) {
        return;
    }

    const activeElement = document.activeElement;

    if (isLocalEditableElement(activeElement)) {
        return;
    }

    const key = String(event.key || '');
    let shortcutType = '';

    if (event.ctrlKey && !event.altKey && !event.metaKey && key.toLowerCase() === 'v') {
        shortcutType = 'ctrl-v';
    } else if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && key === 'Insert') {
        shortcutType = 'shift-insert';
    }

    if (!shortcutType) {
        return;
    }

    if (event.repeat || pendingPasteShortcut?.type === shortcutType) {
        event.stopImmediatePropagation();
        return;
    }

    focusClipboardBridge();
    pendingPasteShortcut = {
        type: shortcutType,
        key
    };
    suppressedPasteKey = shortcutType === 'ctrl-v' ? 'v' : 'Insert';

    window.clearTimeout(clipboardPasteFallbackTimer);
    clipboardPasteFallbackTimer = window.setTimeout(async () => {
        if (!pendingPasteShortcut || pendingPasteShortcut.type !== shortcutType) {
            return;
        }

        try {
            const text = await readLocalClipboardText();

            if (!pendingPasteShortcut || pendingPasteShortcut.type !== shortcutType) {
                return;
            }

            pendingPasteShortcut = null;
            pasteTextIntoRemote(text);
        } catch (_error) {
            if (pendingPasteShortcut?.type === shortcutType) {
                pendingPasteShortcut = null;
                setTemporaryStatus('Paste was blocked by the browser. Click the remote desktop and try again.', 3200);
            }
        }
    }, 80);

    event.stopImmediatePropagation();
}

function handleClipboardKeyup(event) {
    const key = String(event.key || '');
    const normalizedKey = key.toLowerCase();

    if (
        (suppressedPasteKey === 'v' && normalizedKey === 'v')
        || (suppressedPasteKey === 'Insert' && key === 'Insert')
    ) {
        suppressedPasteKey = '';
        event.stopImmediatePropagation();
    }
}

function cleanupClient() {
    window.clearTimeout(resizeTimer);
    window.clearTimeout(statusResetTimer);
    window.clearTimeout(clipboardPasteFallbackTimer);
    // clipboardPasteTimer removed: do not clear synthetic paste timer
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
    pendingPasteShortcut = null;
    suppressedPasteKey = '';
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

        // If user provided host/port in UI, reflect that in the title (best-effort).
        const overrideHost = targetHostInput?.value?.trim();
        const overridePort = targetPortInput?.value?.trim();
        const displayHost = overrideHost || tokenData.targetHost || sessionData.targetHost || '';
        const displayPort = overridePort || tokenData.targetPort || sessionData.targetPort || '';

        viewerTitle.textContent = displayHost ? `${displayHost}${displayPort ? ':' + displayPort : ''} as ${sessionData.username}` : `${sessionData.targetHost} as ${sessionData.username}`;

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
        focusClipboardBridge();

        displayElement.addEventListener('pointerdown', () => {
            window.setTimeout(() => {
                if (client === activeClient) {
                    focusClipboardBridge();
                }
            }, 0);
        });

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

        // Touch -> synthesize mouse events so mobile touch works as clicks/drags
        (function setupTouchToMouse() {
            if (!displayElement) return;
            let lastTap = 0;

            displayElement.addEventListener('touchstart', (e) => {
                if (client !== activeClient) return;
                e.preventDefault();
                const touches = e.changedTouches;

                // Two-finger touch: treat as right-click down
                if (touches.length >= 2) {
                    const t = touches[0];
                    const me = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 2 });
                    displayElement.dispatchEvent(me);
                    return;
                }

                const t = touches[0];
                const me = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0 });
                displayElement.dispatchEvent(me);
            }, { passive: false });

            displayElement.addEventListener('touchmove', (e) => {
                if (client !== activeClient) return;
                e.preventDefault();
                const t = e.changedTouches[0];
                const me = new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0 });
                displayElement.dispatchEvent(me);
            }, { passive: false });

            displayElement.addEventListener('touchend', (e) => {
                if (client !== activeClient) return;
                e.preventDefault();
                const touches = e.changedTouches;

                if (touches.length >= 2) {
                    const t = touches[0];
                    const me = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 2 });
                    displayElement.dispatchEvent(me);
                    return;
                }

                const t = touches[0];
                const me = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0 });
                displayElement.dispatchEvent(me);

                // Double-tap → double-click
                const now = Date.now();
                if (now - lastTap <= 300) {
                    const dblDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0 });
                    const dblUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0 });
                    displayElement.dispatchEvent(dblDown);
                    displayElement.dispatchEvent(dblUp);
                }
                lastTap = now;
            }, { passive: false });
        })();

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

                lastRemoteClipboardText = text || '';

                // Update status and store the text in a visible place if the UI exposes it
                const clipboardArea = document.getElementById('remote-clipboard-area');
                if (clipboardArea) clipboardArea.value = lastRemoteClipboardText;

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
                focusClipboardBridge();
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

// UI clipboard helpers
async function copyRemoteClipboardToLocal() {
    if (!lastRemoteClipboardText) {
        setTemporaryStatus('No remote clipboard data available', 1800);
        return;
    }

    const ok = await copyToLocalClipboard(lastRemoteClipboardText);
    setTemporaryStatus(ok ? 'Remote clipboard copied to local' : 'Copy blocked by browser', ok ? 1800 : 3200);
}

async function pasteLocalClipboardToRemote() {
    if (!isConnected()) {
        setTemporaryStatus('Not connected to remote session', 1600);
        return;
    }

    try {
        const text = await readLocalClipboardText();
        if (!text) {
            setTemporaryStatus('Local clipboard is empty', 1400);
            return;
        }

        pasteTextIntoRemote(text);
    } catch (err) {
        // Try fallback: ask user to paste into textarea
        setTemporaryStatus('Unable to read clipboard (browser blocked). Use manual paste area.', 3000);
    }
}

// Connect-to-target handler
connectTargetButton?.addEventListener('click', () => {
    cleanupClient();
    setOverlay('Starting RDP session', 'Connecting to the selected target...');
    window.setTimeout(() => startViewer(), 200);
});

uiToggle.addEventListener('click', () => {
    infoPanel.classList.toggle('active');
});

reconnectButton.addEventListener('click', handleReconnect);
overlayLogoutButton.addEventListener('click', logout);
logoutButton.addEventListener('click', logout);

// Clipboard bridge is active globally, but only takes over paste gestures while
// the remote viewer has focus.

window.addEventListener('resize', () => {
    scheduleRemoteResize();
});

window.visualViewport?.addEventListener('resize', () => {
    scheduleRemoteResize();
});

// Do not register global paste/clipboard shortcut handlers anymore — let browser/OS
// and the user's keyboard/menu actions flow naturally into the remote session.

window.addEventListener('keydown', handleClipboardShortcut, true);
window.addEventListener('keyup', handleClipboardKeyup, true);
window.addEventListener('paste', handlePaste, true);

display.addEventListener('pointerdown', () => {
    window.setTimeout(() => {
        focusClipboardBridge();
    }, 0);
});

infoPanel.addEventListener('focusin', () => {
    blurClipboardBridge();
});

overlay.addEventListener('focusin', () => {
    blurClipboardBridge();
});

window.addEventListener('beforeunload', () => {
    cleanupClient();
});

startViewer();

// Add optional remote clipboard area to info panel if present (inject if missing)
(function ensureClipboardArea() {
    try {
        const existing = document.getElementById('remote-clipboard-area');
        if (existing) return;

        const panel = infoPanel;
        if (!panel) return;

        const wrapper = document.createElement('div');
        wrapper.style.marginTop = '12px';
        wrapper.innerHTML = `\
            <div style="margin-top:8px">\
            </div>`;

        panel.appendChild(wrapper);

        const copyBtn = document.getElementById('copy-remote-clipboard');
        const pasteBtn = document.getElementById('paste-local-to-remote');

        copyBtn?.addEventListener('click', copyRemoteClipboardToLocal);
        pasteBtn?.addEventListener('click', pasteLocalClipboardToRemote);
    } catch (_e) {
        // no-op
    }
})();

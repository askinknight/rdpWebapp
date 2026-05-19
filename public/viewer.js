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
const drivePanel = document.getElementById('drive-panel');
const driveHint = document.getElementById('drive-hint');
const driveStatus = document.getElementById('drive-status');
const driveList = document.getElementById('drive-list');
const driveDropZone = document.getElementById('drive-drop-zone');
const driveUploadInput = document.getElementById('drive-upload-input');
const driveUploadButton = document.getElementById('drive-upload-button');
const driveOpenFolderButton = document.getElementById('drive-open-folder-button');
const transferPanel = document.getElementById('transfer-panel');
const transferStatus = document.getElementById('transfer-status');
const transferList = document.getElementById('transfer-list');
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
let activeTunnel = null;
let clientState = Guacamole.Client.State.IDLE;
let connecting = false;
let connectedStatus = 'Preparing session...';
let resizeTimer = 0;
let statusResetTimer = 0;
let clipboardSyncTimer = 0;
let lastRequestedSizeKey = '';
let clipboardFallbackInput = null;
let clipboardBridgeInput = null;
let audioUnlockBound = false;
let microphoneRecorder = null;
let microphoneStreamIndex = null;
let microphoneStartAttempted = false;
let sessionCapabilities = null;
let lastRemoteClipboardText = '';
let lastLocalClipboardText = '';
let touchInteraction = createTouchInteractionState();
let currentDrivePath = '';
let drivePollingTimer = 0;
let driveRequestSerial = 0;
let drivePickerActive = false;
let drivePickerReconnectPending = false;
let drivePickerReturnTimer = 0;
let tunnelState = Guacamole.Tunnel.State.CLOSED;
let lastTunnelActivityAt = 0;
let autoReconnectTimer = 0;
let autoReconnectAttempts = 0;

const TOUCH_SCROLL_STEP = Math.max(32, Math.round(24 * (window.devicePixelRatio || 1)));
const TOUCH_RIGHT_CLICK_MAX_MS = 450;
const FLOATING_UI_STORAGE_KEY = 'rdp-viewer-ui-toggle-position';
const FLOATING_UI_MARGIN = 12;
const FLOATING_PANEL_GAP = 12;
const DRIVE_POLL_INTERVAL_MS = 4000;
const AUTO_RECONNECT_MAX_ATTEMPTS = 0;
const AUTO_RECONNECT_BASE_DELAY_MS = 900;
const DEFAULT_DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const uiToggleDragState = {
    active: false,
    moved: false,
    suppressClick: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0
};

const receivedTransferUrls = [];

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

function markTunnelActivity() {
    lastTunnelActivityAt = Date.now();
}

function clearAutomaticReconnect() {
    window.clearTimeout(autoReconnectTimer);
    autoReconnectTimer = 0;
}

function resetAutomaticReconnectAttempts() {
    clearAutomaticReconnect();
    autoReconnectAttempts = 0;
}

function scheduleAutomaticReconnect(reason, { immediate = false } = {}) {
    if (drivePickerActive) {
        drivePickerReconnectPending = true;
        statusText.textContent = 'Restoring session...';
        setOverlay(
            'Restoring RDP session',
            'The connection will resume after the local file dialog closes.'
        );
        return;
    }

    if (connecting || autoReconnectTimer) {
        return;
    }

    if (autoReconnectAttempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
        statusText.textContent = 'Disconnected';
        setOverlay(
            'Session Ended',
            reason || 'The remote session was closed. You can reconnect or logout.',
            false,
            true,
            true
        );
        return;
    }

    autoReconnectAttempts += 1;
    const delay = immediate
        ? 120
        : Math.min(4000, AUTO_RECONNECT_BASE_DELAY_MS * autoReconnectAttempts);

    statusText.textContent = 'Restoring session...';
    setOverlay(
        'Restoring RDP session',
        reason || 'The connection paused while the page was idle. Reconnecting now...'
    );

    autoReconnectTimer = window.setTimeout(() => {
        autoReconnectTimer = 0;

        if (connecting) {
            return;
        }

        startViewer();
    }, delay);
}

function reconnectIfTransportLooksStale(reason, { immediate = false } = {}) {
    if (connecting || drivePickerActive || !client) {
        return;
    }

    const transportClosed = (tunnelState === Guacamole.Tunnel.State.CLOSED);

    if (transportClosed) {
        scheduleAutomaticReconnect(reason, { immediate });
    }
}

function updateTransferStatus(message) {
    if (transferStatus) {
        transferStatus.textContent = message;
    }
}

function isDriveAvailable() {
    const available = Boolean(drivePanel && (sessionCapabilities?.driveEnabled || sessionCapabilities?.localFsEnabled));
    if (!available) {
        console.log('[Drive] Not available', { 
            drivePanel: !!drivePanel, 
            driveEnabled: sessionCapabilities?.driveEnabled,
            localFsEnabled: sessionCapabilities?.localFsEnabled 
        });
    }
    return available;
}

function setDriveHint(message) {
    if (driveHint) {
        driveHint.textContent = message;
    }
}

function setDriveStatus(message) {
    if (driveStatus) {
        driveStatus.textContent = message;
    }
}

function setDriveControlsDisabled(disabled) {
    [driveUploadButton, driveOpenFolderButton].forEach((element) => {
        if (element) {
            element.disabled = disabled;
        }
    });
}

function beginDrivePickerFlow() {
    if (drivePickerActive) {
        return;
    }

    drivePickerActive = true;
    drivePickerReconnectPending = false;
    window.clearTimeout(drivePickerReturnTimer);
    setDriveStatus(`Choose files to upload into ${currentDrivePath || 'the remote home folder'}`);
}

function finishDrivePickerFlow() {
    const shouldReconnect = drivePickerReconnectPending
        || clientState === Guacamole.Client.State.DISCONNECTED;

    window.clearTimeout(drivePickerReturnTimer);
    drivePickerReturnTimer = 0;
    drivePickerActive = false;
    drivePickerReconnectPending = false;

    if (shouldReconnect) {
        statusText.textContent = 'Restoring session...';
        setOverlay(
            'Restoring RDP session',
            'Reconnecting after loading a local file. Please wait a moment.'
        );

        window.setTimeout(() => {
            if (!connecting && !isConnected()) {
                startViewer();
            }
        }, 220);
        return;
    }

    if (!isConnected()) {
        return;
    }

    window.setTimeout(() => {
        scheduleRemoteResize(true);
        focusClipboardBridge();
    }, 120);
}

function scheduleDrivePickerReturn(delay = 160) {
    if (!drivePickerActive) {
        return;
    }

    window.clearTimeout(drivePickerReturnTimer);
    drivePickerReturnTimer = window.setTimeout(() => {
        finishDrivePickerFlow();
    }, delay);
}

function buildDriveApiUrl(relativePath = '') {
    const params = new URLSearchParams();

    if (relativePath) {
        params.set('path', relativePath);
    }

    const query = params.toString();
    const url = query ? `/api/drive?${query}` : '/api/drive';
    console.log('[Drive] buildDriveApiUrl:', { relativePath, url });
    return url;
}

function buildDriveUploadUrl(action = '', { relativePath = '', uploadId = '' } = {}) {
    const params = new URLSearchParams();

    if (relativePath) {
        params.set('path', relativePath);
    }

    if (uploadId) {
        params.set('uploadId', uploadId);
    }

    const suffix = action ? `/${action}` : '';
    const query = params.toString();
    return query ? `/api/drive/upload${suffix}?${query}` : `/api/drive/upload${suffix}`;
}

function buildDriveDownloadUrl(relativePath = '') {
    const params = new URLSearchParams();
    params.set('path', relativePath);
    return `/api/drive/download?${params.toString()}`;
}

function buildDriveFolderDownloadUrl(relativePath = '') {
    const params = new URLSearchParams();
    params.set('path', relativePath);
    return `/api/drive/download-folder?${params.toString()}`;
}

function formatDriveFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '';
    }

    if (bytes === 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;

    return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatDriveTimestamp(timestamp) {
    if (!timestamp) {
        return '';
    }

    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(new Date(timestamp));
    } catch (_error) {
        return timestamp;
    }
}

function clearDriveList() {
    driveList?.replaceChildren();
}

function stopDrivePolling() {
    window.clearInterval(drivePollingTimer);
    drivePollingTimer = 0;
}

function startDrivePolling() {
    if (!isDriveAvailable()) {
        stopDrivePolling();
        return;
    }

    stopDrivePolling();
    drivePollingTimer = window.setInterval(() => {
        if (document.hidden || !sessionCapabilities?.localFsEnabled) {
            return;
        }

        refreshDriveShare({ silent: true });
    }, DRIVE_POLL_INTERVAL_MS);
}

function createDriveEmptyState(message) {
    const empty = document.createElement('div');
    empty.className = 'drive-empty';
    empty.textContent = message;
    return empty;
}

function createDriveActionButton(label, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `drive-action ${className}`.trim();
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function renderDriveList(items = [], parentPath = null) {
    if (!driveList) {
        return;
    }

    driveList.replaceChildren();

    if (parentPath !== null) {
        const upItem = document.createElement('article');
        upItem.className = 'drive-item';

        const main = document.createElement('div');
        main.className = 'drive-item-main';

        const name = document.createElement('div');
        name.className = 'drive-name';
        name.textContent = '..';

        const meta = document.createElement('div');
        meta.className = 'drive-meta';
        meta.textContent = 'Go up one folder';

        main.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'drive-item-actions';
        actions.append(createDriveActionButton('Open', () => {
            loadDriveShare(parentPath);
        }));

        upItem.append(main, actions);
        driveList.append(upItem);
    }

    if (!items.length) {
        driveList.append(createDriveEmptyState('This folder is empty.'));
        return;
    }

    items.forEach((item) => {
        const driveItem = document.createElement('article');
        driveItem.className = 'drive-item';

        const main = document.createElement('div');
        main.className = 'drive-item-main';

        const name = document.createElement('div');
        name.className = 'drive-name';
        name.textContent = item.name;

        const meta = document.createElement('div');
        meta.className = 'drive-meta';
        const details = [
            item.type === 'directory' ? 'Folder' : formatDriveFileSize(item.size),
            formatDriveTimestamp(item.updatedAt)
        ].filter(Boolean);
        meta.textContent = details.join(' | ');

        main.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'drive-item-actions';

        actions.append(createDriveActionButton('Copy Path', () => {
            copyPathToRemoteClipboard(item.path);
        }));

        if (item.type === 'directory') {
            actions.append(createDriveActionButton('Open', () => {
                loadDriveShare(item.path);
            }));

            if (!item.isRoot) {
                const zipLink = document.createElement('a');
                zipLink.className = 'drive-link';
                zipLink.href = buildDriveFolderDownloadUrl(item.path);
                zipLink.textContent = 'Download ZIP';
                zipLink.target = '_blank';
                zipLink.rel = 'noopener';
                actions.append(zipLink);
            }
        } else {
            const downloadLink = document.createElement('a');
            downloadLink.className = 'drive-link';
            downloadLink.href = buildDriveDownloadUrl(item.path);
            downloadLink.textContent = 'Download';
            downloadLink.target = '_blank';
            downloadLink.rel = 'noopener';
            actions.append(downloadLink);
        }

        if (!item.isRoot) {
            actions.append(createDriveActionButton('Delete', () => {
                deleteDriveEntry(item);
            }, 'danger'));
        }

        driveItem.append(main, actions);
        driveList.append(driveItem);
    });
}

async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
        return {};
    }

    try {
        return await response.json();
    } catch (_error) {
        return {};
    }
}

async function loadDriveShare(relativePath = currentDrivePath, { silent = false } = {}) {
    if (!drivePanel) {
        console.log('[Drive] drivePanel not found');
        return;
    }

    if (!isDriveAvailable()) {
        console.log('[Drive] Drive not available, hiding panel');
        drivePanel.hidden = true;
        stopDrivePolling();
        clearDriveList();
        return;
    }

    const requestId = ++driveRequestSerial;
    const url = buildDriveApiUrl(relativePath);
    
    console.log('[Drive] Loading directory:', { relativePath, url, requestId });

    if (!silent) {
        setDriveStatus('Refreshing machine files...');
    }

    try {
        console.log('[Drive] Fetching:', url);
        const response = await fetch(url);
        const data = await parseJsonResponse(response);

        console.log('[Drive] Response:', { status: response.status, data });

        if (requestId !== driveRequestSerial) {
            console.log('[Drive] Request ID mismatch, ignoring response');
            return;
        }

        if (!response.ok) {
            throw new Error(data.error || 'Unable to read machine files');
        }

        currentDrivePath = data.currentPath || '';
        drivePanel.hidden = false;
        setDriveHint(`Browsing shared folder - ${data.remoteHint || 'remote drive'}`);
        renderDriveList(Array.isArray(data.items) ? data.items : [], data.parentPath ?? null);
        setDriveControlsDisabled(false);
        setDriveStatus(
            data.items?.length
                ? `Showing ${data.items.length} item${data.items.length === 1 ? '' : 's'}`
                : `Ready`
        );
    } catch (error) {
        console.error('[Drive] Load error:', error);
        if (requestId !== driveRequestSerial) {
            return;
        }

        setDriveControlsDisabled(false);
        setDriveStatus(error.message || 'Unable to read machine files');
        if (driveList && !driveList.childElementCount) {
            driveList.replaceChildren(createDriveEmptyState(error.message || 'Unable to read machine files'));
        }
    }
}

async function refreshDriveShare(options = {}) {
    return loadDriveShare(currentDrivePath, options);
}

function syncDriveCapabilities(tokenData) {
    console.log('[Drive] Syncing capabilities:', { driveEnabled: tokenData?.driveEnabled, localFsEnabled: tokenData?.localFsEnabled });
    
    if (!drivePanel) {
        return;
    }

    const hasCapability = tokenData?.driveEnabled || tokenData?.localFsEnabled;
    
    if (!hasCapability) {
        console.log('[Drive] No file sharing capability available');
        drivePanel.hidden = true;
        currentDrivePath = '';
        stopDrivePolling();
        clearDriveList();
        return;
    }

    drivePanel.hidden = false;
    setDriveHint('Browsing shared folder');
    setDriveStatus('Loading files...');
    setDriveControlsDisabled(false);
    loadDriveShare('', { silent: false });
    startDrivePolling();
}

async function createDriveFolder() {
    if (!isDriveAvailable()) {
        return;
    }

    const folderName = window.prompt('Folder name');

    if (!folderName) {
        return;
    }

    setDriveStatus(`Creating folder "${folderName}"...`);

    try {
        const response = await fetch('/api/fs/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: currentDrivePath,
                name: folderName
            })
        });
        const data = await parseJsonResponse(response);

        if (!response.ok) {
            throw new Error(data.error || 'Unable to create folder');
        }

        await refreshDriveShare({ silent: true });
        setTemporaryStatus(`Folder created: ${data.item?.name || folderName}`, 2200);
    } catch (error) {
        setDriveStatus(error.message || 'Unable to create folder');
    }
}

async function deleteDriveEntry(item) {
    if (!item?.path) {
        return;
    }

    const confirmed = window.confirm(
        `Delete ${item.type === 'directory' ? 'folder' : 'file'} "${item.name}" from this machine?`
    );

    if (!confirmed) {
        return;
    }

    setDriveStatus(`Deleting ${item.name}...`);

    try {
        const response = await fetch(buildDriveApiUrl(item.path), {
            method: 'DELETE'
        });
        const data = await parseJsonResponse(response);

        if (!response.ok) {
            throw new Error(data.error || 'Unable to delete drive entry');
        }

        await refreshDriveShare({ silent: true });
        setTemporaryStatus(`Deleted: ${item.name}`, 1800);
    } catch (error) {
        setDriveStatus(error.message || 'Unable to delete drive entry');
    }
}

async function uploadDriveFile(file) {
    let uploadId = '';

    try {
        const uploadLimit = Number(sessionCapabilities?.driveMaxUploadBytes || 0);

        if (Number.isFinite(uploadLimit) && uploadLimit > 0 && file.size > uploadLimit) {
            throw new Error(`File exceeds upload limit (${formatDriveFileSize(uploadLimit)})`);
        }

        console.log('[Upload] Starting chunked file upload:', {
            filename: file.name,
            size: file.size,
            currentDrivePath
        });

        const startResponse = await fetch(buildDriveUploadUrl('start', { relativePath: currentDrivePath }), {
            method: 'POST',
            headers: {
                'X-File-Name': encodeURIComponent(file.name),
                'X-File-Size': String(file.size)
            }
        });
        const startData = await parseJsonResponse(startResponse);

        if (!startResponse.ok) {
            throw new Error(startData.error || 'Unable to start upload session');
        }

        uploadId = String(startData.uploadId || '');

        if (!uploadId) {
            throw new Error('Upload session ID was not returned');
        }

        const chunkSize = Math.max(
            1,
            Number(startData.chunkSize) || DEFAULT_DRIVE_UPLOAD_CHUNK_BYTES
        );
        let uploadedBytes = 0;

        while (uploadedBytes < file.size) {
            const chunkEnd = Math.min(uploadedBytes + chunkSize, file.size);
            const chunkBlob = file.slice(uploadedBytes, chunkEnd);

            await new Promise((chunkResolve, chunkReject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', buildDriveUploadUrl('chunk', { uploadId }));
                xhr.responseType = 'json';
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.setRequestHeader('X-Upload-Id', uploadId);
                xhr.setRequestHeader('X-Chunk-Start', String(uploadedBytes));

                xhr.upload.addEventListener('progress', (event) => {
                    const totalLoaded = uploadedBytes + (event.lengthComputable ? event.loaded : 0);

                    if (!file.size) {
                        setDriveStatus(`Uploading ${file.name}...`);
                        return;
                    }

                    const percent = Math.min(100, Math.round((totalLoaded / file.size) * 100));
                    setDriveStatus(`Uploading ${file.name}... ${percent}%`);
                });

                xhr.addEventListener('load', () => {
                    const response = xhr.response && typeof xhr.response === 'object'
                        ? xhr.response
                        : (() => {
                            try {
                                return JSON.parse(xhr.responseText || '{}');
                            } catch (_error) {
                                return {};
                            }
                        })();

                    if (xhr.status >= 200 && xhr.status < 300) {
                        chunkResolve(response);
                        return;
                    }

                    chunkReject(new Error(response.error || `Chunk upload failed with status ${xhr.status}`));
                });

                xhr.addEventListener('error', () => {
                    chunkReject(new Error(`Upload failed for ${file.name}`));
                });

                xhr.addEventListener('abort', () => {
                    chunkReject(new Error(`Upload aborted for ${file.name}`));
                });

                xhr.send(chunkBlob);
            });

            uploadedBytes = chunkEnd;
            const percent = file.size
                ? Math.min(100, Math.round((uploadedBytes / file.size) * 100))
                : 100;
            setDriveStatus(`Uploading ${file.name}... ${percent}%`);
        }

        if (file.size === 0) {
            setDriveStatus(`Uploading ${file.name}...`);
        }

        const completeResponse = await fetch(buildDriveUploadUrl('complete', { uploadId }), {
            method: 'POST',
            headers: {
                'X-Upload-Id': uploadId
            }
        });
        const completeData = await parseJsonResponse(completeResponse);

        if (!completeResponse.ok) {
            throw new Error(completeData.error || 'Unable to finalize upload');
        }

        console.log('[Upload] Success:', file.name);
        return completeData;
    } catch (error) {
        console.error('[Upload] Chunked upload failed:', error);

        if (uploadId) {
            try {
                await fetch(buildDriveUploadUrl('', { uploadId }), {
                    method: 'DELETE',
                    headers: {
                        'X-Upload-Id': uploadId
                    }
                });
            } catch (cancelError) {
                console.warn('[Upload] Failed to cancel upload session:', cancelError);
            }
        }

        throw error;
    }
}

async function handleDriveUploads(fileList) {
    if (!isDriveAvailable() || !fileList?.length) {
        console.log('[Upload] Not available or no files', { isDriveAvailable: isDriveAvailable(), fileCount: fileList?.length });
        return;
    }

    console.log('[Upload] Starting batch upload:', { fileCount: fileList.length, files: Array.from(fileList).map(f => f.name) });
    setDriveControlsDisabled(true);

    try {
        for (const file of Array.from(fileList)) {
            console.log('[Upload] Processing file:', file.name);
            await uploadDriveFile(file);
        }

        await refreshDriveShare({ silent: true });
        const message = `Uploaded ${fileList.length} file${fileList.length === 1 ? '' : 's'}`;
        console.log('[Upload] Batch complete:', message);
        setTemporaryStatus(message, 2600);
    } catch (error) {
        console.error('[Upload] Batch error:', error);
        setDriveStatus(error.message || 'Unable to upload file');
    } finally {
        setDriveControlsDisabled(false);

        if (driveUploadInput) {
            driveUploadInput.value = '';
        }
    }
}

function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function setDriveDragActive(active) {
    drivePanel?.classList.toggle('drag-active', active);
    driveDropZone?.classList.toggle('drag-over', active);
}

function handleDriveDragOver(event) {
    if (!isDriveAvailable() || !hasDraggedFiles(event)) {
        return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDriveDragActive(true);
    setDriveStatus(`Drop files here to upload into ${currentDrivePath || 'the remote home folder'}`);
}

function handleDriveDrop(event) {
    if (!isDriveAvailable() || !hasDraggedFiles(event)) {
        return;
    }

    event.preventDefault();
    setDriveDragActive(false);
    handleDriveUploads(event.dataTransfer.files);
}

function rememberTransferUrl(blobUrl) {
    receivedTransferUrls.push(blobUrl);

    if (receivedTransferUrls.length > 20) {
        const expiredUrl = receivedTransferUrls.shift();
        URL.revokeObjectURL(expiredUrl);
    }
}

function releaseTransferUrls() {
    while (receivedTransferUrls.length) {
        URL.revokeObjectURL(receivedTransferUrls.pop());
    }
}

function appendTransferEntry(filename, mimetype, blobUrl, { printable = false } = {}) {
    if (!transferList) {
        return;
    }

    const item = document.createElement('article');
    item.className = 'transfer-item';

    const name = document.createElement('div');
    name.className = 'transfer-name';
    name.textContent = filename;

    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    meta.textContent = printable
        ? `Printer job received${mimetype ? ` | ${mimetype}` : ''}`
        : (mimetype || 'Remote file');

    const links = document.createElement('div');
    links.className = 'transfer-links';

    const openLink = document.createElement('a');
    openLink.className = 'transfer-link';
    openLink.href = blobUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = printable ? 'Open PDF' : 'Open';

    const downloadLink = document.createElement('a');
    downloadLink.className = 'transfer-link';
    downloadLink.href = blobUrl;
    downloadLink.download = filename;
    downloadLink.textContent = 'Download';

    links.append(openLink, downloadLink);
    item.append(name, meta, links);
    transferList.prepend(item);
}

function getFileExtensionForMimetype(mimetype) {
    switch (String(mimetype || '').toLowerCase()) {
        case 'application/pdf':
            return '.pdf';
        case 'application/postscript':
            return '.ps';
        case 'text/plain':
            return '.txt';
        case 'image/png':
            return '.png';
        case 'image/jpeg':
            return '.jpg';
        case 'image/webp':
            return '.webp';
        default:
            return '';
    }
}

function buildDownloadFilename(filename, mimetype) {
    const trimmedFilename = String(filename || '').trim();

    if (trimmedFilename) {
        return trimmedFilename;
    }

    const extension = getFileExtensionForMimetype(mimetype) || '.bin';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return `remote-file-${timestamp}${extension}`;
}

function openBlobInNewTab(blobUrl) {
    try {
        const openedWindow = window.open(blobUrl, '_blank', 'noopener,noreferrer');
        return Boolean(openedWindow);
    } catch (_error) {
        return false;
    }
}

function triggerBrowserDownload(blobUrl, filename) {
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
        document.body.removeChild(anchor);
    }, 0);
}

function receiveRemoteFile(activeClient, stream, mimetype, filename) {
    stream.sendAck('Ready', Guacamole.Status.Code.SUCCESS);

    const downloadFilename = buildDownloadFilename(filename, mimetype);
    const reader = new Guacamole.BlobReader(stream, mimetype);
    const isPrintablePdf = String(mimetype || '').toLowerCase() === 'application/pdf'
        || downloadFilename.toLowerCase().endsWith('.pdf');

    reader.onprogress = () => {
        if (client === activeClient) {
            statusText.textContent = `Receiving file: ${downloadFilename}`;
            updateTransferStatus(`Receiving: ${downloadFilename}`);
        }
    };

    reader.onend = () => {
        if (client !== activeClient) {
            return;
        }

        const fileBlob = reader.getBlob();
        const blobUrl = URL.createObjectURL(fileBlob);
        rememberTransferUrl(blobUrl);

        const openedInNewTab = isPrintablePdf ? openBlobInNewTab(blobUrl) : false;

        if (!openedInNewTab) {
            triggerBrowserDownload(blobUrl, downloadFilename);
        }

        appendTransferEntry(downloadFilename, mimetype, blobUrl, {
            printable: isPrintablePdf
        });
        updateTransferStatus(`Latest: ${downloadFilename}`);
        toggleInfoPanel(true);

        setTemporaryStatus(
            isPrintablePdf
                ? `Printer job ready: ${downloadFilename}`
                : `Downloaded remote file: ${downloadFilename}`,
            4200
        );

        if (isPrintablePdf) {
            setTemporaryStatus(`Print job received. Use Open PDF if the browser blocked the popup.`, 4600);
        }
        scheduleRemoteResize(true);
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getViewportDimensions() {
    return {
        width: window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
        height: window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0
    };
}

function getUiToggleSize() {
    return {
        width: uiToggle.offsetWidth || 0,
        height: uiToggle.offsetHeight || 0
    };
}

function clampUiTogglePosition(left, top) {
    const viewport = getViewportDimensions();
    const toggleSize = getUiToggleSize();
    const maxLeft = Math.max(FLOATING_UI_MARGIN, viewport.width - toggleSize.width - FLOATING_UI_MARGIN);
    const maxTop = Math.max(FLOATING_UI_MARGIN, viewport.height - toggleSize.height - FLOATING_UI_MARGIN);

    return {
        left: clamp(Math.round(left), FLOATING_UI_MARGIN, maxLeft),
        top: clamp(Math.round(top), FLOATING_UI_MARGIN, maxTop)
    };
}

function persistUiTogglePosition(position) {
    try {
        window.localStorage.setItem(FLOATING_UI_STORAGE_KEY, JSON.stringify(position));
    } catch (_error) {
    }
}

function readPersistedUiTogglePosition() {
    try {
        const rawValue = window.localStorage.getItem(FLOATING_UI_STORAGE_KEY);

        if (!rawValue) {
            return null;
        }

        const parsed = JSON.parse(rawValue);

        if (!Number.isFinite(parsed?.left) || !Number.isFinite(parsed?.top)) {
            return null;
        }

        return {
            left: parsed.left,
            top: parsed.top
        };
    } catch (_error) {
        return null;
    }
}

function positionInfoPanel() {
    if (!infoPanel.classList.contains('active')) {
        return;
    }

    const viewport = getViewportDimensions();
    const toggleRect = uiToggle.getBoundingClientRect();
    const panelWidth = Math.min(infoPanel.offsetWidth || 0, Math.max(0, viewport.width - (FLOATING_UI_MARGIN * 2)));
    const panelHeight = Math.min(infoPanel.offsetHeight || 0, Math.max(0, viewport.height - (FLOATING_UI_MARGIN * 2)));
    const maxLeft = Math.max(FLOATING_UI_MARGIN, viewport.width - panelWidth - FLOATING_UI_MARGIN);
    const maxTop = Math.max(FLOATING_UI_MARGIN, viewport.height - panelHeight - FLOATING_UI_MARGIN);

    let left = toggleRect.left;

    if (left + panelWidth > viewport.width - FLOATING_UI_MARGIN) {
        left = toggleRect.right - panelWidth;
    }

    left = clamp(Math.round(left), FLOATING_UI_MARGIN, maxLeft);

    let top = toggleRect.bottom + FLOATING_PANEL_GAP;

    if (top + panelHeight > viewport.height - FLOATING_UI_MARGIN) {
        top = toggleRect.top - panelHeight - FLOATING_PANEL_GAP;
    }

    top = clamp(Math.round(top), FLOATING_UI_MARGIN, maxTop);

    infoPanel.style.left = `${left}px`;
    infoPanel.style.top = `${top}px`;
    infoPanel.style.right = 'auto';
    infoPanel.style.bottom = 'auto';
}

function applyUiTogglePosition(left, top, { persist = true, repositionPanel = true } = {}) {
    const nextPosition = clampUiTogglePosition(left, top);

    uiToggle.style.left = `${nextPosition.left}px`;
    uiToggle.style.top = `${nextPosition.top}px`;
    uiToggle.style.right = 'auto';
    uiToggle.style.bottom = 'auto';

    if (persist) {
        persistUiTogglePosition(nextPosition);
    }

    if (repositionPanel) {
        positionInfoPanel();
    }
}

function syncFloatingUiToViewport() {
    const rect = uiToggle.getBoundingClientRect();

    applyUiTogglePosition(rect.left, rect.top);

    if (infoPanel.classList.contains('active')) {
        window.requestAnimationFrame(positionInfoPanel);
    }
}

function toggleInfoPanel(forceVisible) {
    const nextVisible = typeof forceVisible === 'boolean'
        ? forceVisible
        : !infoPanel.classList.contains('active');

    infoPanel.classList.toggle('active', nextVisible);

    if (!nextVisible) {
        return;
    }

    positionInfoPanel();
    window.requestAnimationFrame(positionInfoPanel);
}

function handleUiTogglePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) {
        return;
    }

    const rect = uiToggle.getBoundingClientRect();

    uiToggleDragState.active = true;
    uiToggleDragState.moved = false;
    uiToggleDragState.pointerId = event.pointerId;
    uiToggleDragState.startX = event.clientX;
    uiToggleDragState.startY = event.clientY;
    uiToggleDragState.originLeft = rect.left;
    uiToggleDragState.originTop = rect.top;

    uiToggle.classList.add('dragging');
    uiToggle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
}

function handleUiTogglePointerMove(event) {
    if (!uiToggleDragState.active || uiToggleDragState.pointerId !== event.pointerId) {
        return;
    }

    const deltaX = event.clientX - uiToggleDragState.startX;
    const deltaY = event.clientY - uiToggleDragState.startY;

    if (!uiToggleDragState.moved && Math.hypot(deltaX, deltaY) >= 4) {
        uiToggleDragState.moved = true;
    }

    if (!uiToggleDragState.moved) {
        return;
    }

    applyUiTogglePosition(
        uiToggleDragState.originLeft + deltaX,
        uiToggleDragState.originTop + deltaY,
        { persist: false }
    );

    event.preventDefault();
}

function finishUiToggleDrag(event) {
    if (!uiToggleDragState.active || uiToggleDragState.pointerId !== event.pointerId) {
        return;
    }

    if (uiToggleDragState.moved) {
        const deltaX = event.clientX - uiToggleDragState.startX;
        const deltaY = event.clientY - uiToggleDragState.startY;

        applyUiTogglePosition(
            uiToggleDragState.originLeft + deltaX,
            uiToggleDragState.originTop + deltaY
        );
    }

    uiToggleDragState.suppressClick = uiToggleDragState.moved;
    uiToggleDragState.active = false;
    uiToggleDragState.moved = false;
    uiToggleDragState.pointerId = null;

    uiToggle.classList.remove('dragging');
    uiToggle.releasePointerCapture?.(event.pointerId);
}

function initializeFloatingUi() {
    const persistedPosition = readPersistedUiTogglePosition();
    const initialRect = uiToggle.getBoundingClientRect();
    const initialPosition = persistedPosition || {
        left: initialRect.left,
        top: initialRect.top
    };

    applyUiTogglePosition(initialPosition.left, initialPosition.top, {
        persist: Boolean(persistedPosition),
        repositionPanel: false
    });

    uiToggle.addEventListener('pointerdown', handleUiTogglePointerDown);
    uiToggle.addEventListener('pointermove', handleUiTogglePointerMove);
    uiToggle.addEventListener('pointerup', finishUiToggleDrag);
    uiToggle.addEventListener('pointercancel', finishUiToggleDrag);
    uiToggle.addEventListener('click', (event) => {
        if (uiToggleDragState.suppressClick) {
            uiToggleDragState.suppressClick = false;
            event.preventDefault();
            return;
        }

        toggleInfoPanel();
    });

    if (typeof ResizeObserver === 'function') {
        const infoPanelResizeObserver = new ResizeObserver(() => {
            if (infoPanel.classList.contains('active')) {
                positionInfoPanel();
            }
        });

        infoPanelResizeObserver.observe(infoPanel);
    }

    if (infoPanel.classList.contains('active')) {
        toggleInfoPanel(true);
    }
}

function createTouchInteractionState() {
    return {
        mode: 'idle',
        primaryTouchId: null,
        startedAt: 0,
        lastX: 0,
        lastY: 0,
        twoFingerTapCandidate: false
    };
}

function getTouchByIdentifier(touchList, identifier) {
    if (identifier === null || identifier === undefined) {
        return null;
    }

    for (let index = 0; index < touchList.length; index += 1) {
        if (touchList[index].identifier === identifier) {
            return touchList[index];
        }
    }

    return null;
}

function getAverageTouchPosition(touchList) {
    if (!touchList.length) {
        return null;
    }

    let totalX = 0;
    let totalY = 0;

    for (let index = 0; index < touchList.length; index += 1) {
        totalX += touchList[index].clientX;
        totalY += touchList[index].clientY;
    }

    return {
        clientX: totalX / touchList.length,
        clientY: totalY / touchList.length
    };
}

function buildMouseStateFromClientPosition(sourceElement, clientX, clientY, overrides = {}) {
    const position = Guacamole.Position.fromClientPosition(sourceElement, clientX, clientY);

    return new Guacamole.Mouse.State({
        x: position.x,
        y: position.y,
        left: overrides.left ?? false,
        middle: overrides.middle ?? false,
        right: overrides.right ?? false,
        up: overrides.up ?? false,
        down: overrides.down ?? false
    });
}

function syncMouseState(state) {
    if (mouse) {
        mouse.currentState = new Guacamole.Mouse.State(state);
    }
}

function sendMouseStateToRemote(activeClient, state) {
    if (client !== activeClient || !isConnected()) {
        return;
    }

    activeClient.getDisplay().showCursor(true);
    syncMouseState(state);
    activeClient.sendMouseState(state, true);
}

function sendMouseWheelStep(activeClient, sourceElement, clientX, clientY, direction) {
    const isScrollUp = direction === 'up';
    const pressedState = buildMouseStateFromClientPosition(sourceElement, clientX, clientY, {
        up: isScrollUp,
        down: !isScrollUp
    });
    const releasedState = buildMouseStateFromClientPosition(sourceElement, clientX, clientY);

    sendMouseStateToRemote(activeClient, pressedState);
    sendMouseStateToRemote(activeClient, releasedState);
}

function sendRightClick(activeClient, sourceElement, clientX, clientY) {
    const pressedState = buildMouseStateFromClientPosition(sourceElement, clientX, clientY, {
        right: true
    });
    const releasedState = buildMouseStateFromClientPosition(sourceElement, clientX, clientY);

    sendMouseStateToRemote(activeClient, pressedState);
    sendMouseStateToRemote(activeClient, releasedState);
}

function resetTouchInteraction() {
    touchInteraction = createTouchInteractionState();
}

function setupTouchInput(activeClient, displayElement) {
    const releasePrimaryTouch = (touch) => {
        const finalTouch = touch || { clientX: touchInteraction.lastX, clientY: touchInteraction.lastY };
        const releasedState = buildMouseStateFromClientPosition(
            displayElement,
            finalTouch.clientX,
            finalTouch.clientY
        );

        sendMouseStateToRemote(activeClient, releasedState);
        resetTouchInteraction();
    };

    displayElement.addEventListener('touchstart', (event) => {
        if (client !== activeClient || !isConnected()) {
            return;
        }

        if (event.touches.length === 1) {
            const touch = event.touches[0];
            const pressedState = buildMouseStateFromClientPosition(displayElement, touch.clientX, touch.clientY, {
                left: true
            });

            event.preventDefault();
            touchInteraction = {
                mode: 'drag',
                primaryTouchId: touch.identifier,
                startedAt: Date.now(),
                lastX: touch.clientX,
                lastY: touch.clientY,
                twoFingerTapCandidate: false
            };
            sendMouseStateToRemote(activeClient, pressedState);
            return;
        }

        if (event.touches.length === 2) {
            const center = getAverageTouchPosition(event.touches);

            event.preventDefault();

            if (touchInteraction.mode === 'drag') {
                releasePrimaryTouch(center);
            }

            touchInteraction = {
                mode: 'scroll',
                primaryTouchId: null,
                startedAt: Date.now(),
                lastX: center?.clientX || 0,
                lastY: center?.clientY || 0,
                twoFingerTapCandidate: true
            };
            return;
        }

        resetTouchInteraction();
    }, { passive: false });

    displayElement.addEventListener('touchmove', (event) => {
        if (client !== activeClient || !isConnected()) {
            return;
        }

        if (touchInteraction.mode === 'drag') {
            const touch = getTouchByIdentifier(event.touches, touchInteraction.primaryTouchId) || event.touches[0];

            if (!touch) {
                return;
            }

            event.preventDefault();
            touchInteraction.lastX = touch.clientX;
            touchInteraction.lastY = touch.clientY;

            const draggedState = buildMouseStateFromClientPosition(displayElement, touch.clientX, touch.clientY, {
                left: true
            });

            sendMouseStateToRemote(activeClient, draggedState);
            return;
        }

        if (touchInteraction.mode === 'scroll' && event.touches.length >= 2) {
            const center = getAverageTouchPosition(event.touches);
            const deltaY = center.clientY - touchInteraction.lastY;

            event.preventDefault();

            if (Math.abs(deltaY) >= TOUCH_SCROLL_STEP) {
                const steps = Math.trunc(deltaY / TOUCH_SCROLL_STEP);
                const direction = steps < 0 ? 'up' : 'down';

                for (let index = 0; index < Math.abs(steps); index += 1) {
                    sendMouseWheelStep(activeClient, displayElement, center.clientX, center.clientY, direction);
                }

                touchInteraction.lastY += steps * TOUCH_SCROLL_STEP;
                touchInteraction.twoFingerTapCandidate = false;
            }

            touchInteraction.lastX = center.clientX;
        }
    }, { passive: false });

    displayElement.addEventListener('touchend', (event) => {
        if (client !== activeClient || !isConnected()) {
            return;
        }

        if (touchInteraction.mode === 'drag') {
            const touch = getTouchByIdentifier(event.changedTouches, touchInteraction.primaryTouchId)
                || event.changedTouches[0];

            event.preventDefault();
            releasePrimaryTouch(touch);
            return;
        }

        if (touchInteraction.mode === 'scroll') {
            const finalPosition = getAverageTouchPosition(event.changedTouches)
                || { clientX: touchInteraction.lastX, clientY: touchInteraction.lastY };

            event.preventDefault();

            if (
                touchInteraction.twoFingerTapCandidate
                && Date.now() - touchInteraction.startedAt <= TOUCH_RIGHT_CLICK_MAX_MS
            ) {
                sendRightClick(activeClient, displayElement, finalPosition.clientX, finalPosition.clientY);
            }

            resetTouchInteraction();
        }
    }, { passive: false });

    displayElement.addEventListener('touchcancel', () => {
        if (touchInteraction.mode === 'drag') {
            releasePrimaryTouch();
            return;
        }

        resetTouchInteraction();
    }, { passive: false });
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
    if (!isConnected() || document.hidden || drivePickerActive) {
        return;
    }

    // If the server requires a full reconnect to change resolution, avoid
    // triggering a reconnect by using local scaling instead of requesting
    // a remote resize. The server advertises its preferred method via the
    // `resizeMethod` field returned with the token JSON.
    if (sessionCapabilities?.resizeMethod === 'reconnect') {
        setTemporaryStatus('Using local display scaling (server requires reconnect for remote resize)', 1800);
        return;
    }

    const { width, height } = getViewportMetrics();
    const sizeKey = `${width}x${height}`;

    if (!force && sizeKey === lastRequestedSizeKey) {
        return;
    }

    lastRequestedSizeKey = sizeKey;
    try {
        client.sendSize(width, height);
    } catch (error) {
        // If sending size fails, fall back to local scaling and avoid
        // repeatedly trying to resize which could trigger reconnect logic.
        console.warn('[Resize] sendSize failed, falling back to local scaling', error);
        updateDisplayScale();
    }
}

function scheduleRemoteResize(force = false) {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
        requestRemoteResize(force);
    }, 80);
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

async function copyBlobToLocalClipboard(blob, mimetype) {
    if (!blob || !mimetype || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        return false;
    }

    try {
        await navigator.clipboard.write([
            new ClipboardItem({
                [mimetype]: blob
            })
        ]);
        return true;
    } catch (_error) {
        return false;
    }
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

function sendClipboardBlobToRemote(blob, mimetype) {
    if (!isConnected() || !blob || !mimetype) {
        return false;
    }

    const stream = client.createClipboardStream(mimetype);
    const writer = new Guacamole.BlobWriter(stream);

    writer.oncomplete = () => {
        writer.sendEnd();
        setTemporaryStatus('Image clipboard pasted into remote session');
    };

    writer.onerror = () => {
        setTemporaryStatus('Unable to send image clipboard to the remote session', 3200);
    };

    writer.sendBlob(blob);
    return true;
}

function copyPathToRemoteClipboard(targetPath) {
    if (!targetPath) {
        return;
    }

    sendClipboardTextToRemote(targetPath);
    setTemporaryStatus(`Copied path to remote clipboard: ${targetPath}`, 2200);
}

function sendRemotePasteGesture() {
    if (!isConnected()) {
        return;
    }

    sendRemoteKeyChord(CONTROL_LEFT_KEYSYM, V_KEYSYM);
}

function pasteTextIntoRemote(text) {
    if (!text) {
        setTemporaryStatus('Local clipboard is empty', 1400);
        return false;
    }

    sendClipboardTextToRemote(text);
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
    try {
        if (navigator.clipboard?.readText) {
            return await navigator.clipboard.readText();
        }
    } catch (_error) {
    }

    const input = ensureClipboardFallbackInput();
    const originalElement = document.activeElement;
    input.value = '';
    input.focus({ preventScroll: true });
    input.select();

    try {
        if (document.execCommand('paste')) {
            return input.value;
        }
    } catch (_error) {
    } finally {
        input.blur();

        if (originalElement?.focus) {
            try {
                originalElement.focus({ preventScroll: true });
            } catch (_error) {
                originalElement.focus();
            }
        }
    }

    throw new Error('Browser blocked clipboard read');
}

async function syncLocalClipboardToRemote() {
    if (!isConnected()) {
        return false;
    }

    let text = '';

    try {
        text = await readLocalClipboardText();
    } catch (_error) {
        return false;
    }

    if (!text || text === lastLocalClipboardText || text === lastRemoteClipboardText) {
        return false;
    }

    lastLocalClipboardText = text;
    sendClipboardTextToRemote(text);
    return true;
}

function scheduleLocalClipboardSync(delayMs = 100) {
    window.clearTimeout(clipboardSyncTimer);
    clipboardSyncTimer = window.setTimeout(() => {
        syncLocalClipboardToRemote();
    }, delayMs);
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
    const text = (event.clipboardData || window.clipboardData)?.getData('text');
    if (text) {
        sendClipboardTextToRemote(text);
    }
}

function cleanupClient() {
    window.clearTimeout(resizeTimer);
    window.clearTimeout(statusResetTimer);
    window.clearTimeout(drivePickerReturnTimer);
    window.clearTimeout(clipboardSyncTimer);
    clearAutomaticReconnect();
    stopDrivePolling();
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
    clientState = Guacamole.Client.State.IDLE;
    tunnelState = Guacamole.Tunnel.State.CLOSED;
    lastTunnelActivityAt = 0;
    sessionCapabilities = null;
    currentDrivePath = '';
    lastLocalClipboardText = '';
    drivePickerActive = false;
    drivePickerReconnectPending = false;
    drivePickerReturnTimer = 0;
    resetTouchInteraction();

    if (keyboard) {
        keyboard.onkeydown = null;
        keyboard.onkeyup = null;
        keyboard.reset();
        keyboard = null;
    }

    mouse = null;

    client = null;
    activeTunnel = null;

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
    resetAutomaticReconnectAttempts();
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
        sessionCapabilities = tokenData;
        syncDriveCapabilities(tokenData);

        // If user provided host/port in UI, reflect that in the title (best-effort).
        const overrideHost = targetHostInput?.value?.trim();
        const overridePort = targetPortInput?.value?.trim();
        const displayHost = overrideHost || tokenData.targetHost || sessionData.targetHost || '';
        const displayPort = overridePort || tokenData.targetPort || sessionData.targetPort || '';

        viewerTitle.textContent = displayHost ? `${displayHost}${displayPort ? ':' + displayPort : ''} as ${sessionData.username}` : `${sessionData.targetHost} as ${sessionData.username}`;

        let hasConnectedOnce = false;
        const tunnel = new Guacamole.WebSocketTunnel(buildWebSocketUrl());
        const activeClient = new Guacamole.Client(tunnel);
        client = activeClient;
        activeTunnel = tunnel;
        clientState = Guacamole.Client.State.IDLE;
        tunnelState = tunnel.state;
        markTunnelActivity();

        const originalTunnelSendMessage = tunnel.sendMessage.bind(tunnel);
        tunnel.sendMessage = (...args) => {
            markTunnelActivity();

            try {
                return originalTunnelSendMessage(...args);
            } catch (error) {
                if (client === activeClient && hasConnectedOnce) {
                    scheduleAutomaticReconnect(
                        'The browser lost the live RDP connection while the page was idle. Reconnecting now...',
                        { immediate: true }
                    );
                }
            }

            return undefined;
        };

        const originalTunnelInstructionHandler = tunnel.oninstruction;
        tunnel.oninstruction = (opcode, parameters) => {
            if (client !== activeClient) {
                return;
            }

            markTunnelActivity();
            originalTunnelInstructionHandler?.(opcode, parameters);
        };

        tunnel.onerror = () => {
            if (client !== activeClient || !hasConnectedOnce) {
                return;
            }

            scheduleAutomaticReconnect(
                'The live RDP link became unavailable while the page was idle. Reconnecting now...',
                { immediate: true }
            );
        };

        tunnel.onstatechange = (state) => {
            if (client !== activeClient) {
                return;
            }

            tunnelState = state;
            markTunnelActivity();

            if (state === Guacamole.Tunnel.State.UNSTABLE && isConnected()) {
                statusText.textContent = 'Connection unstable, restoring session...';
                return;
            }

            if (state === Guacamole.Tunnel.State.CLOSED && hasConnectedOnce) {
                scheduleAutomaticReconnect(
                    'The browser lost the live RDP connection while the page was idle. Reconnecting now...',
                    { immediate: true }
                );
            }
        };

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

        setupTouchInput(activeClient, displayElement);

        /* Legacy synthetic MouseEvent touch shim retained only for quick rollback.
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

                // Double-tap -> double-click
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
        */

        activeClient.getDisplay().oncursor = (canvas, x, y) => {
            if (client !== activeClient || !mouse) {
                return;
            }

            const usingNativeCursor = mouse.setCursor(canvas, x, y);
            activeClient.getDisplay().showCursor(!usingNativeCursor);
        };

        keyboard = new Guacamole.Keyboard(window);
        keyboard.onkeydown = (keysym) => {
            if (isLocalEditableElement(document.activeElement)) {
                return true;
            }
            if (client === activeClient && isConnected()) {
                activeClient.sendKeyEvent(1, keysym);
            }
            // Allow Ctrl+C, Ctrl+V, and Ctrl+X to reach the browser
            const isModifier = keyboard.pressed[0xFFE3] || keyboard.pressed[0xFFE4] || keyboard.pressed[0xFFE7] || keyboard.pressed[0xFFE8];
            if (isModifier && (keysym === 0x63 || keysym === 0x76 || keysym === 0x78)) {
                return true;
            }
            return false;
        };
        keyboard.onkeyup = (keysym) => {
            if (isLocalEditableElement(document.activeElement)) {
                return true;
            }
            if (client === activeClient && isConnected()) {
                activeClient.sendKeyEvent(0, keysym);
            }
            // Allow Ctrl+C, Ctrl+V, and Ctrl+X to reach the browser
            const isModifier = keyboard.pressed[0xFFE3] || keyboard.pressed[0xFFE4] || keyboard.pressed[0xFFE7] || keyboard.pressed[0xFFE8];
            if (isModifier && (keysym === 0x63 || keysym === 0x76 || keysym === 0x78)) {
                return true;
            }
            return false;
        };

        activeClient.onclipboard = (stream, mimetype) => {
            if (client !== activeClient) {
                return;
            }

            if (/^text\//i.test(mimetype)) {
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
                    lastLocalClipboardText = lastRemoteClipboardText;

                    // Sync to bridge so native browser copy works
                    const bridge = ensureClipboardBridgeInput();
                    bridge.value = lastRemoteClipboardText;
                    bridge.select();

                    const clipboardArea = document.getElementById('remote-clipboard-area');
                    if (clipboardArea) clipboardArea.value = lastRemoteClipboardText;

                    const copied = await copyToLocalClipboard(text);
                    setTemporaryStatus(
                        copied
                            ? 'Clipboard synced from remote session'
                            : 'Remote clipboard received. Press Ctrl+C to copy to local.',
                        copied ? 1800 : 3200
                    );
                };

                return;
            }

            if (/^image\//i.test(mimetype)) {
                const reader = new Guacamole.BlobReader(stream, mimetype);
                statusText.textContent = 'Receiving image clipboard data...';

                reader.onend = async () => {
                    if (client !== activeClient) {
                        return;
                    }

                    const imageBlob = reader.getBlob();
                    const copied = await copyBlobToLocalClipboard(imageBlob, mimetype);

                    if (copied) {
                        setTemporaryStatus('Image clipboard synced from remote session', 2200);
                        return;
                    }

                    const filename = buildDownloadFilename('', mimetype).replace(/^remote-file-/, 'remote-clipboard-');
                    const blobUrl = URL.createObjectURL(imageBlob);
                    rememberTransferUrl(blobUrl);
                    appendTransferEntry(filename, mimetype, blobUrl);
                    toggleInfoPanel(true);
                    setTemporaryStatus('Remote image clipboard received, but the browser blocked automatic copy', 3600);
                };
            }
        };

        activeClient.onfile = (stream, mimetype, filename) => {
            if (client !== activeClient) {
                return;
            }

            receiveRemoteFile(activeClient, stream, mimetype, filename);
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
            tunnelState = Guacamole.Tunnel.State.CLOSED;

            const isAuthorizationError = (
                error.code === Guacamole.Status.Code.CLIENT_UNAUTHORIZED
                || error.code === Guacamole.Status.Code.UPSTREAM_UNAUTHORIZED
            );

            if (drivePickerActive && !isAuthorizationError) {
                drivePickerReconnectPending = true;
                statusText.textContent = 'Restoring session...';
                setOverlay(
                    'Restoring RDP session',
                    'The connection will resume after the local file dialog closes.'
                );
                return;
            }

            let message = error.message || 'An unexpected RDP error occurred.';
            if (isAuthorizationError) {
                message = 'Access denied. Please verify the RDP username and password.';
            }

            if (!isAuthorizationError && hasConnectedOnce) {
                scheduleAutomaticReconnect(
                    'The live RDP session paused unexpectedly. Reconnecting now...',
                    { immediate: true }
                );
                return;
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
                hasConnectedOnce = true;
                connecting = false;
                tunnelState = activeTunnel?.state ?? Guacamole.Tunnel.State.OPEN;
                markTunnelActivity();
                resetAutomaticReconnectAttempts();
                statusText.textContent = connectedStatus;
                hideOverlay();
                focusClipboardBridge();
                scheduleLocalClipboardSync(250);
                scheduleRemoteResize(true);

                if (tokenData.microphoneMimetype || negotiateAudioTypes(tokenData).length) {
                    setTemporaryStatus('Click or press a key once to enable audio and microphone', 3200);
                }

                if (tokenData.printerEnabled) {
                    window.setTimeout(() => {
                        if (client === activeClient && isConnected()) {
                            setTemporaryStatus(`Printer redirection enabled: ${tokenData.printerName}`, 2800);
                        }
                    }, 400);
                }

                if (tokenData.localFsEnabled) {
                    window.setTimeout(() => {
                        if (client === activeClient && isConnected()) {
                            setTemporaryStatus('Machine file browser ready for this RDP host', 3200);
                        }
                    }, tokenData.printerEnabled ? 1200 : 400);
                }

                return;
            }

            if (state === Guacamole.Client.State.DISCONNECTED) {
                connecting = false;
                tunnelState = Guacamole.Tunnel.State.CLOSED;

                if (drivePickerActive) {
                    drivePickerReconnectPending = true;
                    statusText.textContent = 'Restoring session...';
                    setOverlay(
                        'Restoring RDP session',
                        'The connection will resume after the local file dialog closes.'
                    );
                    return;
                }

                if (hasConnectedOnce) {
                    scheduleAutomaticReconnect(
                        'The live RDP session was interrupted while the page was idle. Reconnecting now...',
                        { immediate: true }
                    );
                    return;
                }

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
    syncLocalClipboardToRemote();
}

// Connect-to-target handler
connectTargetButton?.addEventListener('click', () => {
    cleanupClient();
    setOverlay('Starting RDP session', 'Connecting to the selected target...');
    window.setTimeout(() => startViewer(), 200);
});

reconnectButton.addEventListener('click', handleReconnect);
overlayLogoutButton.addEventListener('click', logout);
logoutButton.addEventListener('click', logout);
driveUploadButton?.addEventListener('click', () => {
    if (!isDriveAvailable()) {
        console.log('[Drive] Upload button clicked but drive not available');
        return;
    }
    if (!driveUploadInput) {
        return;
    }

    beginDrivePickerFlow();
    console.log('[Drive] Opening file picker');
    driveUploadInput.click();
});
driveUploadInput?.addEventListener('change', (event) => {
    console.log('[Drive] File picker changed:', event.target?.files?.length);
    scheduleDrivePickerReturn(0);
    handleDriveUploads(event.target?.files);
});
driveUploadInput?.addEventListener('cancel', () => {
    console.log('[Drive] File picker cancelled');
    scheduleDrivePickerReturn(0);
});
driveOpenFolderButton?.addEventListener('click', () => {
    if (!isDriveAvailable()) {
        console.log('[Drive] Open folder clicked but drive not available');
        return;
    }
    console.log('[Drive] Opening shared folder root');
    currentDrivePath = '';
    refreshDriveShare({ silent: false });
});
driveDropZone?.addEventListener('click', () => {
    if (!isDriveAvailable()) {
        return;
    }

    if (!driveUploadInput) {
        return;
    }

    beginDrivePickerFlow();
    driveUploadInput.click();
});
drivePanel?.addEventListener('dragenter', (event) => {
    if (!isDriveAvailable() || !hasDraggedFiles(event)) {
        return;
    }

    event.preventDefault();
    setDriveDragActive(true);
});
drivePanel?.addEventListener('dragover', handleDriveDragOver);
drivePanel?.addEventListener('dragleave', (event) => {
    if (!drivePanel?.contains(event.relatedTarget)) {
        setDriveDragActive(false);
    }
});
drivePanel?.addEventListener('drop', handleDriveDrop);

// Clipboard bridge is active globally, but only takes over paste gestures while
// the remote viewer has focus.

window.addEventListener('resize', () => {
    scheduleRemoteResize();
    syncFloatingUiToViewport();
});

window.visualViewport?.addEventListener('resize', () => {
    scheduleRemoteResize();
    syncFloatingUiToViewport();
});

// Do not register global paste/clipboard shortcut handlers anymore - let browser/OS
// and the user's keyboard/menu actions flow naturally into the remote session.

window.addEventListener('copy', () => scheduleLocalClipboardSync(), false);
window.addEventListener('cut', () => scheduleLocalClipboardSync(), false);
window.addEventListener('paste', handlePaste, false);

window.addEventListener('focus', (event) => {
    if (event.target === window) {
        scheduleLocalClipboardSync();
    }
}, true);

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        return;
    }

    if (drivePickerActive) {
        scheduleDrivePickerReturn();
    }

    if (isConnected()) {
        scheduleRemoteResize(true);
        focusClipboardBridge();
    }

    reconnectIfTransportLooksStale(
        'The browser resumed after being idle and the RDP link needs to be restored.',
        { immediate: true }
    );

    if (isDriveAvailable()) {
        refreshDriveShare({ silent: true });
    }
});

window.addEventListener('focus', () => {
    if (drivePickerActive) {
        scheduleDrivePickerReturn();
        return;
    }

    if (!isConnected()) {
        return;
    }

    window.setTimeout(() => {
        scheduleRemoteResize(true);
        focusClipboardBridge();
        reconnectIfTransportLooksStale(
            'The browser resumed after being idle and the RDP link needs to be restored.',
            { immediate: true }
        );
    }, 80);
});

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
    releaseTransferUrls();
});

initializeFloatingUi();
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
        positionInfoPanel();

        const copyBtn = document.getElementById('copy-remote-clipboard');
        const pasteBtn = document.getElementById('paste-local-to-remote');

        copyBtn?.addEventListener('click', copyRemoteClipboardToLocal);
        pasteBtn?.addEventListener('click', pasteLocalClipboardToRemote);
    } catch (_e) {
        // no-op
    }
})();

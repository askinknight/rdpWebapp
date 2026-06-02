const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const archiver = require('archiver');
const express = require('express');
const session = require('express-session');
const SftpClient = require('ssh2-sftp-client');

const PORT = Number(process.env.PORT || 3000);
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT || 4822);
const GUACD_MAX_INACTIVITY_MS = clampInteger(process.env.GUACD_MAX_INACTIVITY_MS, 0, 0, 86400000);
const CLIENT_MAX_INACTIVITY_MS = clampInteger(process.env.CLIENT_MAX_INACTIVITY_MS, 0, 0, 86400000);
const RDP_HOST = process.env.RDP_HOST || '203.154.0.219';
const RDP_PORT = Number(process.env.RDP_PORT ||4490);
const SUPPORTED_RDP_SECURITY_MODES = ['any', 'nla', 'tls', 'rdp'];
const REQUESTED_RDP_SECURITY = String(process.env.RDP_SECURITY || '').trim().toLowerCase();
const REQUESTED_RDP_VALIDATION_SECURITY = String(process.env.RDP_VALIDATION_SECURITY || '').trim().toLowerCase();
const RDP_SECURITY = SUPPORTED_RDP_SECURITY_MODES.includes(REQUESTED_RDP_SECURITY)
    ? REQUESTED_RDP_SECURITY
    : 'any';
const RDP_VALIDATION_SECURITY = SUPPORTED_RDP_SECURITY_MODES.includes(REQUESTED_RDP_VALIDATION_SECURITY)
    ? REQUESTED_RDP_VALIDATION_SECURITY
    : (RDP_SECURITY === 'any' ? 'nla' : RDP_SECURITY);
const RDP_FORCE_DISPLAY_UPDATE = parseBoolean(process.env.RDP_FORCE_DISPLAY_UPDATE, false);
const RDP_RESIZE_METHOD = RDP_FORCE_DISPLAY_UPDATE
    ? 'display-update'
    : (['display-update', 'reconnect'].includes(process.env.RDP_RESIZE_METHOD)
        ? process.env.RDP_RESIZE_METHOD
        : 'display-update');
const SUPPORTED_CONNECTION_TYPES = ['full', 'edge', 'onlyoffice'];
const SUPPORTED_RDP_APP_LAUNCH_MODES = ['initial-program', 'remote-app'];
const REQUESTED_RDP_APP_LAUNCH_MODE = String(process.env.RDP_APP_LAUNCH_MODE || '').trim().toLowerCase();
const RDP_APP_LAUNCH_MODE = SUPPORTED_RDP_APP_LAUNCH_MODES.includes(REQUESTED_RDP_APP_LAUNCH_MODE)
    ? REQUESTED_RDP_APP_LAUNCH_MODE
    : 'initial-program';
const RDP_EDGE_APP_PATH = process.env.RDP_EDGE_APP_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const RDP_EDGE_INITIAL_PROGRAM = process.env.RDP_EDGE_INITIAL_PROGRAM || RDP_EDGE_APP_PATH;
const RDP_EDGE_REMOTE_APP = process.env.RDP_EDGE_REMOTE_APP
    || '||msedge';
const RDP_EDGE_REMOTE_APP_ARGS = process.env.RDP_EDGE_REMOTE_APP_ARGS
    || '--new-window --no-first-run --no-default-browser-check --start-maximized --user-data-dir=C:\\Windows\\Temp\\EdgeRemoteApp';
const RDP_ONLYOFFICE_APP_PATH = process.env.RDP_ONLYOFFICE_APP_PATH
    || 'C:\\Program Files\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe';
const RDP_ONLYOFFICE_INITIAL_PROGRAM = process.env.RDP_ONLYOFFICE_INITIAL_PROGRAM || RDP_ONLYOFFICE_APP_PATH;
const RDP_ONLYOFFICE_REMOTE_APP = process.env.RDP_ONLYOFFICE_REMOTE_APP
    || '||DesktopEditors';
const RDP_ONLYOFFICE_REMOTE_APP_DIR = process.env.RDP_ONLYOFFICE_REMOTE_APP_DIR
    || 'C:\\Program Files\\ONLYOFFICE\\DesktopEditors';

console.log(`[RDP] Resize method configured: ${RDP_RESIZE_METHOD}${RDP_FORCE_DISPLAY_UPDATE ? ' (forced via RDP_FORCE_DISPLAY_UPDATE)' : ''}`);
console.log(`[RDP] App launch mode configured: ${RDP_APP_LAUNCH_MODE}`);
if (RDP_APP_LAUNCH_MODE === 'remote-app' && !RDP_EDGE_REMOTE_APP.startsWith('||')) {
    console.warn(`[RDP] Edge RemoteApp value should usually be an alias like "||msedge", not a file path: ${RDP_EDGE_REMOTE_APP}`);
}
if (RDP_APP_LAUNCH_MODE === 'remote-app' && !RDP_ONLYOFFICE_REMOTE_APP.startsWith('||')) {
    console.warn(`[RDP] ONLYOFFICE RemoteApp value should usually be an alias like "||DesktopEditors", not a file path: ${RDP_ONLYOFFICE_REMOTE_APP}`);
}
const RDP_CLIPBOARD_NORMALIZATION = ['preserve', 'unix', 'windows'].includes(process.env.RDP_CLIPBOARD_NORMALIZATION)
    ? process.env.RDP_CLIPBOARD_NORMALIZATION
    : 'windows';
const RDP_COLOR_DEPTH = clampInteger(process.env.RDP_COLOR_DEPTH, 32, 8, 32);
const RDP_AUDIO_TYPES = String(process.env.RDP_AUDIO_TYPES || 'audio/L16,audio/L8')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const RDP_MIC_BASE_TYPE = ['audio/L16', 'audio/L8'].includes(process.env.RDP_MIC_BASE_TYPE)
    ? process.env.RDP_MIC_BASE_TYPE
    : 'audio/L16';
const RDP_MIC_RATE = clampInteger(process.env.RDP_MIC_RATE, 44100, 8000, 192000);
const RDP_MIC_CHANNELS = clampInteger(process.env.RDP_MIC_CHANNELS, 2, 1, 2);
const RDP_ENABLE_WALLPAPER = parseBoolean(process.env.RDP_ENABLE_WALLPAPER, false);
const RDP_ENABLE_FULL_WINDOW_DRAG = parseBoolean(process.env.RDP_ENABLE_FULL_WINDOW_DRAG, false);
const RDP_ENABLE_DESKTOP_COMPOSITION = parseBoolean(process.env.RDP_ENABLE_DESKTOP_COMPOSITION, false);
const RDP_ENABLE_FONT_SMOOTHING = parseBoolean(process.env.RDP_ENABLE_FONT_SMOOTHING, false);
const RDP_ENABLE_MENU_ANIMATIONS = parseBoolean(process.env.RDP_ENABLE_MENU_ANIMATIONS, false);
const RDP_ENABLE_THEMING = parseBoolean(process.env.RDP_ENABLE_THEMING, false);
const RDP_DISABLE_GFX = parseBoolean(process.env.RDP_DISABLE_GFX, false);
const RDP_ENABLE_PRINTING = parseBoolean(process.env.RDP_ENABLE_PRINTING, true);
const RDP_PRINTER_NAME = String(process.env.RDP_PRINTER_NAME || 'Browser Printer').trim() || 'Browser Printer';
const RDP_ENABLE_DRIVE = parseBoolean(process.env.RDP_ENABLE_DRIVE, true);
const RDP_DRIVE_NAME = String(process.env.RDP_DRIVE_NAME || 'Shared_Folder').trim() || 'Shared_Folder';
const RDP_DRIVE_MAX_UPLOAD_MB = clampInteger(process.env.RDP_DRIVE_MAX_UPLOAD_MB, 1024, 1, 10240);
const RDP_DRIVE_MAX_UPLOAD_BYTES = RDP_DRIVE_MAX_UPLOAD_MB * 1024 * 1024;
const DRIVE_STORAGE_ROOT = path.resolve(
    process.env.RDP_DRIVE_STORAGE_ROOT || path.join(__dirname, 'shared-folder')
);
const RDP_DRIVE_UPLOAD_CHUNK_MB = clampInteger(process.env.RDP_DRIVE_UPLOAD_CHUNK_MB, 8, 1, 64);
const RDP_DRIVE_UPLOAD_CHUNK_BYTES = RDP_DRIVE_UPLOAD_CHUNK_MB * 1024 * 1024;
const RDP_DRIVE_UPLOAD_TTL_MS = clampInteger(process.env.RDP_DRIVE_UPLOAD_TTL_MS, 3600000, 60000, 86400000);
const DRIVE_UPLOAD_TEMP_ROOT = path.resolve(DRIVE_STORAGE_ROOT);

const GUACD_DRIVE_MOUNT = process.env.GUACD_DRIVE_MOUNT || '/shared-folder';
const SFTP_ENABLED = parseBoolean(process.env.SFTP_ENABLED, false);
const SFTP_HOST = process.env.SFTP_HOST || RDP_HOST;
const SFTP_PORT = clampInteger(process.env.SFTP_PORT, 22, 1, 65535);
const SFTP_START_PATH = String(process.env.SFTP_START_PATH || '').trim();
const SFTP_READY_TIMEOUT_MS = clampInteger(process.env.SFTP_READY_TIMEOUT_MS, 15000, 1000, 120000);
const SFTP_MAX_UPLOAD_MB = clampInteger(process.env.SFTP_MAX_UPLOAD_MB, 1024, 1, 10240);
const SFTP_MAX_UPLOAD_BYTES = SFTP_MAX_UPLOAD_MB * 1024 * 1024;
const LOCAL_FS_ENABLED = parseBoolean(process.env.LOCAL_FS_ENABLED, true);
const LOCAL_FS_ROOTS = String(process.env.LOCAL_FS_ROOTS || '').trim();
const LOCAL_FS_MAX_UPLOAD_MB = clampInteger(process.env.LOCAL_FS_MAX_UPLOAD_MB, 1024, 1, 10240);
const LOCAL_FS_MAX_UPLOAD_BYTES = LOCAL_FS_MAX_UPLOAD_MB * 1024 * 1024;
const LOGIN_VALIDATION_TTL_MS = clampInteger(process.env.LOGIN_VALIDATION_TTL_MS, 300000, 10000, 86400000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-token-secret';

const TOKEN_CIPHER = 'AES-256-CBC';
const tokenKey = crypto.createHash('sha256').update(TOKEN_SECRET).digest();
const GuacamoleLite = loadPatchedGuacamoleLite();
const driveUploadSessions = new Map();

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(['/api/session', '/api/debug/session', '/api/guacamole-token'], noStore);
app.use(
    session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: false
        }
    })
);

app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(
    '/vendor/guacamole',
    // Serve the browser UMD/ES build (dist) rather than CommonJS (dist/cjs)
    express.static(path.join(__dirname, 'node_modules', 'guacamole-common-js', 'dist' , 'cjs'))
);

function encryptToken(payload) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(TOKEN_CIPHER, tokenKey, iv);

    let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return Buffer.from(
        JSON.stringify({
            iv: iv.toString('base64'),
            value: encrypted
        })
    ).toString('base64');
}

function requireAuth(req, res, next) {
    if (!req.session.rdpAuth) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        return res.redirect('/login');
    }

    next();
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback) {
    if (typeof value !== 'string') {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();

    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}

function normalizeConnectionType(value) {
    const requestedConnectionType = String(value || 'full').trim().toLowerCase();
    return SUPPORTED_CONNECTION_TYPES.includes(requestedConnectionType) ? requestedConnectionType : 'full';
}

function applyAppLaunchSettings(settings, connectionType) {
    if (RDP_APP_LAUNCH_MODE === 'initial-program') {
        if (connectionType === 'edge') {
            settings['initial-program'] = RDP_EDGE_INITIAL_PROGRAM;
            return;
        }

        if (connectionType === 'onlyoffice') {
            settings['initial-program'] = RDP_ONLYOFFICE_INITIAL_PROGRAM;
        }

        return;
    }

    if (connectionType === 'edge') {
        settings['remote-app'] = RDP_EDGE_REMOTE_APP;
        settings['remote-app-args'] = RDP_EDGE_REMOTE_APP_ARGS;
        return;
    }

    if (connectionType === 'onlyoffice') {
        settings['remote-app'] = RDP_ONLYOFFICE_REMOTE_APP;
        settings['remote-app-dir'] = RDP_ONLYOFFICE_REMOTE_APP_DIR;
    }
}

function loadPatchedGuacamoleLite() {
    const guacdClientModulePath = require.resolve('guacamole-lite/lib/GuacdClient.js');
    const OriginalGuacdClient = require(guacdClientModulePath);

    class PatchedGuacdClient extends OriginalGuacdClient {
        constructor(...args) {
            super(...args);

            if (this.activityCheckInterval) {
                clearInterval(this.activityCheckInterval);
                this.activityCheckInterval = null;
            }

            if (GUACD_MAX_INACTIVITY_MS > 0) {
                this.activityCheckInterval = setInterval(() => {
                    if (Date.now() > (this.lastActivity + GUACD_MAX_INACTIVITY_MS)) {
                        this.close(new Error(`guacd was inactive for too long (${GUACD_MAX_INACTIVITY_MS}ms)`));
                    }
                }, 1000);
            }
        }
    }

    require.cache[guacdClientModulePath].exports = PatchedGuacdClient;
    return require('guacamole-lite');
}

function getRequestedDisplaySettings(req) {
    return {
        width: clampInteger(req.query.width, 1366, 640, 8192),
        height: clampInteger(req.query.height, 768, 480, 8192),
        dpi: clampInteger(req.query.dpi, 96, 72, 384),
        timezone: typeof req.query.timezone === 'string' ? req.query.timezone.trim() : ''
    };
}

function buildRawAudioMimetype(baseType, rate, channels) {
    return `${baseType};rate=${rate},channels=${channels}`;
}

function applyTrueFlag(target, key, enabled) {
    if (enabled) {
        target[key] = true;
    }
}

function buildRdpExperienceSettings() {
    const settings = {
        'color-depth': RDP_COLOR_DEPTH,
        'enable-touch': true,
        'enable-wallpaper': true, //RDP_ENABLE_WALLPAPER,
        'enable-full-window-drag': RDP_ENABLE_FULL_WINDOW_DRAG,
        'enable-desktop-composition': RDP_ENABLE_DESKTOP_COMPOSITION,
        'enable-font-smoothing': RDP_ENABLE_FONT_SMOOTHING,
        'enable-menu-animations': RDP_ENABLE_MENU_ANIMATIONS,
        'enable-theming': RDP_ENABLE_THEMING
    };

    applyTrueFlag(settings, 'disable-gfx', RDP_DISABLE_GFX);

    return settings;
}

function buildRdpPrinterSettings(enabled = RDP_ENABLE_PRINTING) {
    const settings = {};

    applyTrueFlag(settings, 'enable-printing', enabled);

    if (enabled && RDP_PRINTER_NAME) {
        settings['printer-name'] = RDP_PRINTER_NAME;
    }

    return settings;
}

function buildRdpDriveSettings(enabled = RDP_ENABLE_DRIVE) {
    const settings = {};

    applyTrueFlag(settings, 'enable-drive', enabled);
    applyTrueFlag(settings, 'create-drive-path', enabled);

    if (enabled && RDP_DRIVE_NAME) {
        settings['drive-name'] = RDP_DRIVE_NAME;
    }

    return settings;
}

function createDriveId() {
    return crypto.randomBytes(16).toString('hex');
}

function getPendingRdpAuth(req) {
    const pendingAuth = req.session?.pendingRdpAuth;

    if (!pendingAuth) {
        return null;
    }

    if (
        !Number.isFinite(Number(pendingAuth.createdAt))
        || Number(pendingAuth.createdAt) + LOGIN_VALIDATION_TTL_MS < Date.now()
    ) {
        delete req.session.pendingRdpAuth;
        return null;
    }

    return pendingAuth;
}

function getSessionRdpAuth(req, { allowPendingValidation = false } = {}) {
    if (allowPendingValidation) {
        return getPendingRdpAuth(req) || req.session?.rdpAuth || null;
    }

    return req.session?.rdpAuth || null;
}

function getSessionDriveId(req) {
    return String(getSessionRdpAuth(req)?.driveId || '').trim();
}

function getSessionDriveIdsForCleanup(req) {
    return Array.from(new Set([
        req.session?.rdpAuth?.driveId,
        req.session?.pendingRdpAuth?.driveId
    ].filter((value) => typeof value === 'string' && value.trim())));
}

function getDriveRoot(driveId) {
    return path.resolve(DRIVE_STORAGE_ROOT, driveId);
}

function normalizeDriveRelativePath(value = '') {
    const normalized = String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .trim();

    if (!normalized || normalized === '.') {
        return '';
    }

    const segments = normalized.split('/').filter(Boolean);

    if (segments.some((segment) => segment === '.' || segment === '..')) {
        throw new Error('Invalid drive path');
    }

    return segments.join('/');
}

function isPathWithinDirectory(parentPath, childPath) {
    const parent = path.resolve(parentPath);
    const child = path.resolve(childPath);
    const normalizedParent = process.platform === 'win32' ? parent.toLowerCase() : parent;
    const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child;

    return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function resolveDrivePath(driveId, relativePath = '') {
    if (!driveId) {
        throw new Error('Drive is unavailable for this session');
    }

    const driveRoot = getDriveRoot(driveId);
    const normalizedRelativePath = normalizeDriveRelativePath(relativePath);
    const targetPath = path.resolve(driveRoot, normalizedRelativePath);

    if (!isPathWithinDirectory(driveRoot, targetPath)) {
        throw new Error('Drive path escaped root directory');
    }

    return targetPath;
}

function sanitizeDriveEntryName(name) {
    const safeName = path.basename(String(name || '').trim())
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();

    if (!safeName || safeName === '.' || safeName === '..') {
        throw new Error('Invalid file or folder name');
    }

    return safeName;
}

function decodeDriveHeaderValue(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_error) {
        return String(value || '');
    }
}

function getDriveParentPath(relativePath) {
    if (!relativePath) {
        return null;
    }

    const segments = normalizeDriveRelativePath(relativePath).split('/');
    segments.pop();

    return segments.length ? segments.join('/') : '';
}

function getDriveChildPath(relativePath, entryName) {
    const normalizedParent = normalizeDriveRelativePath(relativePath);
    return normalizedParent ? `${normalizedParent}/${entryName}` : entryName;
}

async function ensureDriveRootDirectory(driveId) {
    const driveRoot = resolveDrivePath(driveId);
    await fs.promises.mkdir(driveRoot, { recursive: true });
    return driveRoot;
}

async function ensureDriveDirectory(driveId, relativePath = '') {
    const targetPath = resolveDrivePath(driveId, relativePath);
    await fs.promises.mkdir(targetPath, { recursive: true });
    return targetPath;
}

async function removeDriveRootDirectory(driveId) {
    if (!driveId) {
        return;
    }

    await fs.promises.rm(getDriveRoot(driveId), {
        recursive: true,
        force: true
    });
}

function createDriveUploadId() {
    return crypto.randomBytes(18).toString('hex');
}

async function ensureDriveUploadTempDirectory(driveId) {
    const tempDirectory = path.resolve(DRIVE_UPLOAD_TEMP_ROOT, sanitizeDriveEntryName(driveId));
    await fs.promises.mkdir(tempDirectory, { recursive: true });
    return tempDirectory;
}

async function cleanupDriveUploadSession(uploadId) {
    const uploadSession = driveUploadSessions.get(uploadId);

    if (!uploadSession) {
        return;
    }

    driveUploadSessions.delete(uploadId);

    if (uploadSession.tempPath) {
        await fs.promises.rm(uploadSession.tempPath, { force: true }).catch(() => {
        });
    }
}

async function cleanupDriveUploadSessionsForSession(sessionId) {
    if (!sessionId) {
        return;
    }

    const matchingUploadIds = [];

    driveUploadSessions.forEach((uploadSession, uploadId) => {
        if (uploadSession.sessionId === sessionId) {
            matchingUploadIds.push(uploadId);
        }
    });

    await Promise.all(matchingUploadIds.map((uploadId) => cleanupDriveUploadSession(uploadId)));
}

async function cleanupExpiredDriveUploadSessions() {
    const now = Date.now();
    const expiredUploadIds = [];

    driveUploadSessions.forEach((uploadSession, uploadId) => {
        if (uploadSession.updatedAt + RDP_DRIVE_UPLOAD_TTL_MS < now) {
            expiredUploadIds.push(uploadId);
        }
    });

    await Promise.all(expiredUploadIds.map((uploadId) => cleanupDriveUploadSession(uploadId)));
}

async function createDriveUploadSession(req, driveId, relativePath, sourceFilename, expectedSize) {
    await cleanupExpiredDriveUploadSessions();

    const uploadId = createDriveUploadId();
    const tempDirectory = await ensureDriveUploadTempDirectory(driveId);
    const tempPath = path.join(tempDirectory, `${uploadId}.part`);
    const handle = await fs.promises.open(tempPath, 'wx');

    await handle.close();

    const uploadSession = {
        uploadId,
        sessionId: req.sessionID,
        driveId,
        relativePath,
        sourceFilename,
        expectedSize,
        receivedBytes: 0,
        tempPath,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    driveUploadSessions.set(uploadId, uploadSession);
    return uploadSession;
}

function getDriveUploadSession(req, uploadId) {
    const normalizedUploadId = String(uploadId || '').trim();

    if (!normalizedUploadId) {
        throw new Error('Missing upload ID');
    }

    const uploadSession = driveUploadSessions.get(normalizedUploadId);

    if (!uploadSession) {
        throw new Error('Upload session not found');
    }

    if (uploadSession.sessionId !== req.sessionID) {
        throw new Error('Upload session is unauthorized');
    }

    if (uploadSession.driveId !== getSessionDriveId(req)) {
        throw new Error('Drive session changed');
    }

    return uploadSession;
}

function buildDriveInfoPayload(relativePath, items = [], extra = {}) {
    return {
        enabled: RDP_ENABLE_DRIVE,
        driveName: RDP_DRIVE_NAME,
        remoteHint: `This PC > ${RDP_DRIVE_NAME}`,
        currentPath: relativePath,
        parentPath: getDriveParentPath(relativePath),
        uploadMaxBytes: RDP_DRIVE_MAX_UPLOAD_BYTES,
        items,
        ...extra
    };
}

async function listDriveDirectory(driveId, relativePath = '') {
    const normalizedRelativePath = normalizeDriveRelativePath(relativePath);
    const directoryPath = await ensureDriveDirectory(driveId, normalizedRelativePath);
    const directoryEntries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    const items = await Promise.all(
        directoryEntries.map(async (entry) => {
            const entryRelativePath = getDriveChildPath(normalizedRelativePath, entry.name);
            const entryAbsolutePath = resolveDrivePath(driveId, entryRelativePath);
            const stats = await fs.promises.stat(entryAbsolutePath);

            return {
                name: entry.name,
                path: entryRelativePath,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isDirectory() ? null : stats.size,
                updatedAt: stats.mtime.toISOString()
            };
        })
    );

    return items.sort((left, right) => {
        if (left.type !== right.type) {
            return left.type === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
}

async function reserveUniqueDriveFile(driveId, relativeDirectoryPath, originalFilename) {
    const targetDirectory = await ensureDriveDirectory(driveId, relativeDirectoryPath);
    const parsedName = path.parse(sanitizeDriveEntryName(originalFilename));
    const baseName = parsedName.name || 'upload';
    const extension = parsedName.ext || '';

    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const candidateName = attempt === 0
            ? `${baseName}${extension}`
            : `${baseName} (${attempt})${extension}`;
        const candidatePath = path.join(targetDirectory, candidateName);

        try {
            const handle = await fs.promises.open(candidatePath, 'wx');
            return {
                handle,
                filename: candidateName,
                absolutePath: candidatePath,
                relativePath: getDriveChildPath(relativeDirectoryPath, candidateName)
            };
        } catch (error) {
            if (error.code === 'EEXIST') {
                continue;
            }

            throw error;
        }
    }

    throw new Error('Unable to allocate a unique filename in the redirected drive');
}

function getConfiguredLocalFsRoots() {
    const configuredRoots = LOCAL_FS_ROOTS
        .split(/[;\n]/)
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => path.resolve(value))
        .filter((value, index, values) => values.indexOf(value) === index);

    if (configuredRoots.length) {
        return configuredRoots;
    }

    if (process.platform === 'win32') {
        const driveRoots = [];

        for (let code = 67; code <= 90; code += 1) {
            const driveRoot = `${String.fromCharCode(code)}:\\`;

            if (fs.existsSync(driveRoot)) {
                driveRoots.push(path.resolve(driveRoot));
            }
        }

        if (driveRoots.length) {
            return driveRoots;
        }
    }

    return [path.resolve(os.homedir())];
}

function getAllowedLocalFsRoots() {
    return getConfiguredLocalFsRoots().filter((rootPath) => {
        try {
            return fs.statSync(rootPath).isDirectory();
        } catch (_error) {
            return false;
        }
    });
}

function resolveAllowedLocalFsRoot(targetPath) {
    const absoluteTargetPath = path.resolve(targetPath);

    return getAllowedLocalFsRoots().find((rootPath) => isPathWithinDirectory(rootPath, absoluteTargetPath)) || null;
}

function resolveLocalFsPath(requestedPath = '') {
    const sanitizedPath = String(requestedPath || '').trim();

    if (!sanitizedPath) {
        return '';
    }

    const absoluteTargetPath = path.resolve(sanitizedPath);
    const matchingRoot = resolveAllowedLocalFsRoot(absoluteTargetPath);

    if (!matchingRoot) {
        throw new Error('Path is outside the allowed local filesystem roots');
    }

    return absoluteTargetPath;
}

function getLocalFsParentPath(currentPath) {
    const absoluteCurrentPath = resolveLocalFsPath(currentPath);
    const matchingRoot = resolveAllowedLocalFsRoot(absoluteCurrentPath);

    if (!matchingRoot || path.resolve(matchingRoot) === path.resolve(absoluteCurrentPath)) {
        return null;
    }

    return path.dirname(absoluteCurrentPath);
}

function sanitizeLocalFsEntryName(name) {
    const sanitizedName = path.basename(String(name || '').trim())
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();

    if (!sanitizedName || sanitizedName === '.' || sanitizedName === '..') {
        throw new Error('Invalid file or folder name');
    }

    return sanitizedName;
}

async function reserveUniqueLocalFsFile(directoryPath, originalFilename) {
    const parsedName = path.parse(sanitizeLocalFsEntryName(originalFilename));
    const baseName = parsedName.name || 'upload';
    const extension = parsedName.ext || '';

    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const candidateName = attempt === 0
            ? `${baseName}${extension}`
            : `${baseName} (${attempt})${extension}`;
        const candidatePath = path.join(directoryPath, candidateName);

        try {
            const handle = await fs.promises.open(candidatePath, 'wx');
            return {
                handle,
                filename: candidateName,
                absolutePath: candidatePath
            };
        } catch (error) {
            if (error.code === 'EEXIST') {
                continue;
            }

            throw error;
        }
    }

    throw new Error('Unable to allocate a unique filename in the local filesystem');
}

async function listLocalFsDirectory(currentPath = '') {
    if (!currentPath) {
        return getAllowedLocalFsRoots().map((rootPath) => ({
            name: rootPath,
            path: rootPath,
            type: 'directory',
            size: null,
            updatedAt: null,
            isRoot: true
        }));
    }

    const absoluteCurrentPath = resolveLocalFsPath(currentPath);
    const directoryEntries = await fs.promises.readdir(absoluteCurrentPath, { withFileTypes: true });
    const items = await Promise.all(
        directoryEntries.map(async (entry) => {
            const entryPath = path.join(absoluteCurrentPath, entry.name);
            const stats = await fs.promises.stat(entryPath);

            return {
                name: entry.name,
                path: entryPath,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isDirectory() ? null : stats.size,
                updatedAt: stats.mtime.toISOString(),
                isRoot: false
            };
        })
    );

    return items.sort((left, right) => {
        if (left.type !== right.type) {
            return left.type === 'directory' ? -1 : 1;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
}

function sanitizeRemoteEntryName(name) {
    const sanitized = String(name || '')
        .replace(/\0/g, '')
        .replace(/[\\/]/g, '')
        .trim();

    if (!sanitized || sanitized === '.' || sanitized === '..') {
        throw new Error('Invalid file or folder name');
    }

    return sanitized;
}

function sanitizeRemotePath(value = '') {
    return String(value || '')
        .replace(/\0/g, '')
        .replace(/\\/g, '/')
        .trim();
}

function isAbsoluteRemotePath(value = '') {
    return value.startsWith('/') || /^[A-Za-z]:([/]|$)/.test(value);
}

function normalizeRemotePath(value = '') {
    const sanitized = sanitizeRemotePath(value);

    if (!sanitized) {
        return '';
    }

    const normalized = path.posix.normalize(sanitized);

    if (normalized === '.') {
        return '';
    }

    if (/^[A-Za-z]:$/.test(normalized) || /^\/[A-Za-z]:$/.test(normalized)) {
        return `${normalized}/`;
    }

    return normalized;
}

function resolveRemotePath(basePath, requestedPath = '') {
    const sanitized = sanitizeRemotePath(requestedPath);

    if (!sanitized) {
        return normalizeRemotePath(basePath || '/');
    }

    if (isAbsoluteRemotePath(sanitized)) {
        return normalizeRemotePath(sanitized);
    }

    return normalizeRemotePath(path.posix.join(normalizeRemotePath(basePath || '/'), sanitized));
}

function joinRemotePath(parentPath, childName) {
    return resolveRemotePath(parentPath || '/', sanitizeRemoteEntryName(childName));
}

function getRemoteParentPath(remotePath = '') {
    const normalized = normalizeRemotePath(remotePath);

    if (
        !normalized
        || normalized === '/'
        || /^[A-Za-z]:\/?$/.test(normalized)
        || /^\/[A-Za-z]:\/?$/.test(normalized)
    ) {
        return null;
    }

    const trimmedPath = normalized.endsWith('/') && normalized.length > 1
        ? normalized.slice(0, -1)
        : normalized;
    const parentPath = path.posix.dirname(trimmedPath);

    if (!parentPath || parentPath === '.') {
        return null;
    }

    if (/^[A-Za-z]:$/.test(parentPath) || /^\/[A-Za-z]:$/.test(parentPath)) {
        return `${parentPath}/`;
    }

    return parentPath;
}

function buildSftpConnectionConfig(auth) {
    return {
        host: SFTP_HOST,
        port: SFTP_PORT,
        username: auth.username,
        password: auth.password,
        readyTimeout: SFTP_READY_TIMEOUT_MS
    };
}

async function resolveSftpHomePath(sftp) {
    const currentWorkingDirectory = await sftp.cwd().catch(() => '');
    const resolvedWorkingDirectory = currentWorkingDirectory
        ? await sftp.realPath(currentWorkingDirectory).catch(() => currentWorkingDirectory)
        : '';

    if (SFTP_START_PATH) {
        return resolveRemotePath(resolvedWorkingDirectory || '/', SFTP_START_PATH);
    }

    return normalizeRemotePath(resolvedWorkingDirectory || currentWorkingDirectory || '/');
}

async function withSftpClient(req, callback) {
    if (!SFTP_ENABLED) {
        throw new Error('SFTP browser is disabled');
    }

    const auth = req.session?.rdpAuth;

    if (!auth?.username || !auth?.password) {
        throw new Error('SFTP credentials are unavailable for this session');
    }

    const sftp = new SftpClient(`session-${Date.now()}`);

    try {
        await sftp.connect(buildSftpConnectionConfig(auth));
        const homePath = await resolveSftpHomePath(sftp);
        return await callback(sftp, homePath);
    } finally {
        await sftp.end().catch(() => {
        });
    }
}

async function buildSftpDirectoryListing(sftp, currentPath) {
    const items = await sftp.list(currentPath);

    return items
        .map((entry) => ({
            name: entry.name,
            path: joinRemotePath(currentPath, entry.name),
            type: entry.type === 'd' ? 'directory' : 'file',
            size: entry.type === 'd' ? null : entry.size,
            updatedAt: Number.isFinite(entry.modifyTime)
                ? new Date(entry.modifyTime).toISOString()
                : null
        }))
        .sort((left, right) => {
            if (left.type !== right.type) {
                return left.type === 'directory' ? -1 : 1;
            }

            return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        });
}

async function allocateRemoteUploadPath(sftp, remoteDirectoryPath, originalFilename) {
    const parsedName = path.posix.parse(sanitizeRemoteEntryName(originalFilename));
    const baseName = parsedName.name || 'upload';
    const extension = parsedName.ext || '';

    for (let attempt = 0; attempt < 1000; attempt += 1) {
        const candidateName = attempt === 0
            ? `${baseName}${extension}`
            : `${baseName} (${attempt})${extension}`;
        const candidatePath = joinRemotePath(remoteDirectoryPath, candidateName);
        const existingEntryType = await sftp.exists(candidatePath);

        if (!existingEntryType) {
            return {
                filename: candidateName,
                remotePath: candidatePath
            };
        }
    }

    throw new Error('Unable to allocate a unique filename on the remote server');
}

app.get('/', (req, res) => {
    res.redirect(req.session.rdpAuth ? '/rdp' : '/login');
});

app.get('/login', (req, res) => {
    if (req.session.rdpAuth) {
        return res.redirect('/rdp');
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/rdp', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.post('/api/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const connectionType = normalizeConnectionType(req.body.connectionType);
    console.log(`[Login] requested connectionType=${connectionType}`);

    req.session.pendingRdpAuth = {
        username,
        password,
        driveId: createDriveId(),
        connectionType,
        createdAt: Date.now()
    };
    delete req.session.rdpAuth;

    res.json({
        ok: true,
        validateMode: connectionType === 'full' ? 'guacamole' : 'skip',
        redirectTo: '/rdp',
        connectionType
    });
});

app.post('/api/login/confirm', (req, res) => {
    const pendingAuth = getPendingRdpAuth(req);

    if (!pendingAuth) {
        return res.status(400).json({ error: 'Login validation expired. Please try again.' });
    }

    req.session.rdpAuth = {
        username: pendingAuth.username,
        password: pendingAuth.password,
        driveId: pendingAuth.driveId,
        connectionType: normalizeConnectionType(pendingAuth.connectionType)
    };
    console.log(`[Login] confirmed connectionType=${req.session.rdpAuth.connectionType}`);
    delete req.session.pendingRdpAuth;

    res.json({ ok: true, redirectTo: '/rdp', connectionType: req.session.rdpAuth.connectionType });
});

app.post('/api/logout', (req, res) => {
    const driveIds = getSessionDriveIdsForCleanup(req);
    const sessionId = req.sessionID;

    req.session.destroy(() => {
        cleanupDriveUploadSessionsForSession(sessionId).catch((error) => {
            console.error(`Failed to clean upload sessions for ${sessionId}:`, error.message);
        });

        driveIds.forEach((driveId) => {
            removeDriveRootDirectory(driveId).catch((error) => {
                console.error(`Failed to remove drive share ${driveId}:`, error.message);
            });
        });

        res.json({ ok: true, redirectTo: '/login' });
    });
});

app.get('/api/session', (req, res) => {
    res.json({
        authenticated: Boolean(req.session.rdpAuth),
        username: req.session.rdpAuth?.username || null,
        targetHost: RDP_HOST,
        driveEnabled: RDP_ENABLE_DRIVE,
        driveName: RDP_DRIVE_NAME,
        localFsEnabled: LOCAL_FS_ENABLED,
        sftpEnabled: SFTP_ENABLED,
        sftpTarget: `${SFTP_HOST}:${SFTP_PORT}`,
        connectionType: req.session.rdpAuth?.connectionType || null
    });
});

// DEBUG: return session driveId and basic session info (remove in production)
app.get('/api/debug/session', requireAuth, (req, res) => {
    res.json({
        authenticated: Boolean(req.session.rdpAuth),
        username: req.session.rdpAuth?.username || null,
        driveId: req.session.rdpAuth?.driveId || null,
        connectionType: req.session.rdpAuth?.connectionType || null
    });
});

app.get('/api/guacamole-token', (req, res) => {
    const validationOnly = String(req.query.mode || '').toLowerCase() === 'validate';
    const sessionAuth = getSessionRdpAuth(req, { allowPendingValidation: validationOnly });

    if (!sessionAuth) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { width, height, dpi, timezone } = getRequestedDisplaySettings(req);
    const settings = {
        'hostname': RDP_HOST,
        'port': RDP_PORT,
        'username': sessionAuth.username,
        'password': sessionAuth.password,
        'width': width,
        'height': height,
        'dpi': dpi,
        'audio': validationOnly ? [] : RDP_AUDIO_TYPES,
        'server-layout': 'th-th-qwerty',
        'security': validationOnly ? RDP_VALIDATION_SECURITY : RDP_SECURITY,
        'ignore-cert': true,
        'resize-method': RDP_RESIZE_METHOD,
        ...buildRdpExperienceSettings(),
        ...buildRdpDriveSettings(!validationOnly && RDP_ENABLE_DRIVE),
        ...buildRdpPrinterSettings(!validationOnly && RDP_ENABLE_PRINTING),
        'enable-clipboard': true,
        'normalize-clipboard': RDP_CLIPBOARD_NORMALIZATION
    };

    applyTrueFlag(settings, 'disable-audio', validationOnly);
    applyTrueFlag(settings, 'enable-audio-input', !validationOnly);
    applyTrueFlag(settings, 'disable-copy', validationOnly);
    applyTrueFlag(settings, 'disable-paste', validationOnly);

    if (timezone) {
        settings.timezone = timezone;
    }

    // Validate credentials with a plain RDP probe, then launch the selected app only in the real viewer session.
    const connectionType = normalizeConnectionType(sessionAuth.connectionType);
    if (!validationOnly) {
        applyAppLaunchSettings(settings, connectionType);
    }
    console.log(
        `[RDP] token mode=${validationOnly ? 'validate' : 'viewer'} connectionType=${connectionType} launchMode=${connectionType === 'full' ? 'desktop' : RDP_APP_LAUNCH_MODE} initialProgram=${settings['initial-program'] || 'none'} remoteApp=${settings['remote-app'] || 'none'}`
    );

    const token = encryptToken({
        driveId: sessionAuth.driveId,
        connection: {
            type: 'rdp',
            settings
        }
    });

    res.json({
        token,
        wsPath: '/',
        targetHost: RDP_HOST,
        targetPort: RDP_PORT,
        connectionType,
        appLaunchMode: connectionType === 'full' ? 'desktop' : RDP_APP_LAUNCH_MODE,
        resizeMethod: RDP_RESIZE_METHOD,
        validationOnly,
        driveEnabled: !validationOnly && RDP_ENABLE_DRIVE,
        driveName: !validationOnly && RDP_ENABLE_DRIVE ? RDP_DRIVE_NAME : null,
        driveMaxUploadBytes: !validationOnly && RDP_ENABLE_DRIVE ? RDP_DRIVE_MAX_UPLOAD_BYTES : null,
        localFsEnabled: !validationOnly && LOCAL_FS_ENABLED,
        localFsMaxUploadBytes: !validationOnly && LOCAL_FS_ENABLED ? LOCAL_FS_MAX_UPLOAD_BYTES : null,
        sftpEnabled: !validationOnly && SFTP_ENABLED,
        sftpTarget: !validationOnly && SFTP_ENABLED ? `${SFTP_HOST}:${SFTP_PORT}` : null,
        sftpMaxUploadBytes: !validationOnly && SFTP_ENABLED ? SFTP_MAX_UPLOAD_BYTES : null,
        printerEnabled: !validationOnly && RDP_ENABLE_PRINTING,
        printerName: !validationOnly && RDP_ENABLE_PRINTING ? RDP_PRINTER_NAME : null,
        audioTypes: validationOnly ? [] : RDP_AUDIO_TYPES,
        microphoneMimetype: validationOnly
            ? null
            : buildRawAudioMimetype(RDP_MIC_BASE_TYPE, RDP_MIC_RATE, RDP_MIC_CHANNELS)
    });
});

app.get('/api/fs', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    try {
        const currentPath = resolveLocalFsPath(req.query.path);
        const items = await listLocalFsDirectory(currentPath);

        if (currentPath) {
            const currentStats = await fs.promises.stat(currentPath);

            if (!currentStats.isDirectory()) {
                throw new Error('Selected path is not a folder');
            }
        }

        res.json({
            enabled: true,
            currentPath,
            parentPath: currentPath ? getLocalFsParentPath(currentPath) : null,
            remoteHint: 'this machine',
            uploadMaxBytes: LOCAL_FS_MAX_UPLOAD_BYTES,
            items
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to browse the local filesystem' });
    }
});

app.post('/api/fs/folder', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    try {
        const parentPath = resolveLocalFsPath(req.body.path);

        if (!parentPath) {
            throw new Error('Choose a drive or folder before creating a new folder');
        }

        const parentStats = await fs.promises.stat(parentPath);

        if (!parentStats.isDirectory()) {
            throw new Error('Target path is not a folder');
        }

        const folderName = sanitizeLocalFsEntryName(req.body.name);
        const folderPath = resolveLocalFsPath(path.join(parentPath, folderName));
        await fs.promises.mkdir(folderPath);

        res.status(201).json({
            ok: true,
            item: {
                name: folderName,
                path: folderPath,
                type: 'directory'
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to create folder' });
    }
});

app.post('/api/fs/upload', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    let reservedFile = null;

    try {
        const parentPath = resolveLocalFsPath(req.query.path);
        const sourceFilename = decodeDriveHeaderValue(req.get('x-file-name'));
        const contentLength = Number.parseInt(req.get('content-length') || '', 10);

        if (!parentPath) {
            throw new Error('Choose a drive or folder before uploading files');
        }

        if (!sourceFilename) {
            return res.status(400).json({ error: 'Missing X-File-Name header' });
        }

        if (Number.isFinite(contentLength) && contentLength > LOCAL_FS_MAX_UPLOAD_BYTES) {
            return res.status(413).json({ error: 'File exceeds upload limit' });
        }

        const parentStats = await fs.promises.stat(parentPath);

        if (!parentStats.isDirectory()) {
            throw new Error('Target path is not a folder');
        }

        reservedFile = await reserveUniqueLocalFsFile(parentPath, sourceFilename);

        let bytesReceived = 0;
        req.on('data', (chunk) => {
            bytesReceived += chunk.length;

            if (bytesReceived > LOCAL_FS_MAX_UPLOAD_BYTES) {
                req.destroy(new Error('File exceeds upload limit'));
            }
        });

        const writeStream = reservedFile.handle.createWriteStream();
        await pipeline(req, writeStream);
        await reservedFile.handle.close().catch(() => {
        });

        const fileStats = await fs.promises.stat(reservedFile.absolutePath);

        res.status(201).json({
            ok: true,
            item: {
                name: reservedFile.filename,
                path: reservedFile.absolutePath,
                type: 'file',
                size: fileStats.size,
                updatedAt: fileStats.mtime.toISOString()
            }
        });
    } catch (error) {
        await reservedFile?.handle?.close().catch(() => {
        });

        if (reservedFile?.absolutePath) {
            await fs.promises.rm(reservedFile.absolutePath, { force: true }).catch(() => {
            });
        }

        const isFileTooLarge = error.message === 'File exceeds upload limit';
        res.status(isFileTooLarge ? 413 : 400).json({
            error: error.message || 'Unable to upload file'
        });
    }
});

app.get('/api/fs/download', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    try {
        const targetPath = resolveLocalFsPath(req.query.path);

        if (!targetPath) {
            throw new Error('Select a file to download');
        }

        const fileStats = await fs.promises.stat(targetPath);

        if (!fileStats.isFile()) {
            throw new Error('Only files can be downloaded directly');
        }

        res.download(targetPath, path.basename(targetPath));
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to download file' });
    }
});

app.get('/api/fs/download-folder', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    try {
        const targetPath = resolveLocalFsPath(req.query.path);

        if (!targetPath) {
            throw new Error('Select a folder to download as ZIP');
        }

        const folderStats = await fs.promises.stat(targetPath);

        if (!folderStats.isDirectory()) {
            throw new Error('Only folders can be downloaded as ZIP archives');
        }

        const folderName = path.basename(targetPath) || 'folder';
        res.attachment(`${folderName}.zip`);
        res.setHeader('Content-Type', 'application/zip');

        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        archive.on('error', (error) => {
            res.destroy(error);
        });

        archive.pipe(res);
        archive.directory(targetPath, folderName);
        archive.finalize();
    } catch (error) {
        if (!res.headersSent) {
            res.status(400).json({ error: error.message || 'Unable to download folder' });
            return;
        }

        res.destroy(error);
    }
});

app.delete('/api/fs', requireAuth, async (req, res) => {
    if (!LOCAL_FS_ENABLED) {
        return res.status(404).json({ error: 'Local filesystem browser is disabled' });
    }

    try {
        const targetPath = resolveLocalFsPath(req.query.path);
        const matchingRoot = targetPath ? resolveAllowedLocalFsRoot(targetPath) : null;

        if (!targetPath || !matchingRoot) {
            throw new Error('Select a file or folder to delete');
        }

        if (path.resolve(targetPath) === path.resolve(matchingRoot)) {
            throw new Error('Refusing to delete a root drive or root folder');
        }

        const entryStats = await fs.promises.stat(targetPath);

        await fs.promises.rm(targetPath, {
            recursive: entryStats.isDirectory(),
            force: true
        });

        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to delete file or folder' });
    }
});

app.get('/api/sftp', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    try {
        const result = await withSftpClient(req, async (sftp, homePath) => {
            const currentPath = resolveRemotePath(homePath, req.query.path);
            const entryType = await sftp.exists(currentPath);

            if (!entryType) {
                throw new Error('Remote path not found');
            }

            if (entryType !== 'd') {
                throw new Error('Remote path is not a folder');
            }

            return {
                currentPath,
                homePath,
                parentPath: getRemoteParentPath(currentPath),
                items: await buildSftpDirectoryListing(sftp, currentPath)
            };
        });

        res.json({
            enabled: true,
            currentPath: result.currentPath,
            homePath: result.homePath,
            parentPath: result.parentPath,
            remoteHint: `SFTP ${SFTP_HOST}:${SFTP_PORT}`,
            uploadMaxBytes: SFTP_MAX_UPLOAD_BYTES,
            items: result.items
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to browse remote files over SFTP' });
    }
});

app.post('/api/sftp/folder', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    try {
        const result = await withSftpClient(req, async (sftp, homePath) => {
            const currentPath = resolveRemotePath(homePath, req.body.path);
            const entryType = await sftp.exists(currentPath);

            if (entryType !== 'd') {
                throw new Error('Target folder does not exist');
            }

            const folderName = sanitizeRemoteEntryName(req.body.name);
            const folderPath = joinRemotePath(currentPath, folderName);

            await sftp.mkdir(folderPath, false);

            return {
                name: folderName,
                path: folderPath
            };
        });

        res.status(201).json({
            ok: true,
            item: {
                name: result.name,
                path: result.path,
                type: 'directory'
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to create remote folder' });
    }
});

app.post('/api/sftp/upload', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    try {
        const sourceFilename = decodeDriveHeaderValue(req.get('x-file-name'));
        const contentLength = Number.parseInt(req.get('content-length') || '', 10);

        if (!sourceFilename) {
            return res.status(400).json({ error: 'Missing X-File-Name header' });
        }

        if (Number.isFinite(contentLength) && contentLength > SFTP_MAX_UPLOAD_BYTES) {
            return res.status(413).json({ error: 'File exceeds upload limit' });
        }

        const result = await withSftpClient(req, async (sftp, homePath) => {
            const currentPath = resolveRemotePath(homePath, req.query.path);
            const entryType = await sftp.exists(currentPath);

            if (entryType !== 'd') {
                throw new Error('Target folder does not exist');
            }

            const remoteTarget = await allocateRemoteUploadPath(sftp, currentPath, sourceFilename);
            let bytesReceived = 0;

            req.on('data', (chunk) => {
                bytesReceived += chunk.length;

                if (bytesReceived > SFTP_MAX_UPLOAD_BYTES) {
                    req.destroy(new Error('File exceeds upload limit'));
                }
            });

            await sftp.put(req, remoteTarget.remotePath);
            const fileStats = await sftp.stat(remoteTarget.remotePath);

            return {
                name: remoteTarget.filename,
                path: remoteTarget.remotePath,
                size: fileStats.size,
                updatedAt: Number.isFinite(fileStats.modifyTime)
                    ? new Date(fileStats.modifyTime).toISOString()
                    : null
            };
        });

        res.status(201).json({
            ok: true,
            item: {
                ...result,
                type: 'file'
            }
        });
    } catch (error) {
        const isFileTooLarge = error.message === 'File exceeds upload limit';
        res.status(isFileTooLarge ? 413 : 400).json({
            error: error.message || 'Unable to upload file over SFTP'
        });
    }
});

app.get('/api/sftp/download', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    try {
        await withSftpClient(req, async (sftp, homePath) => {
            const remotePath = resolveRemotePath(homePath, req.query.path);
            const entryType = await sftp.exists(remotePath);

            if (!entryType) {
                throw new Error('Remote path not found');
            }

            if (entryType === 'd') {
                throw new Error('Folders must be downloaded as ZIP archives');
            }

            const filename = path.posix.basename(remotePath.replace(/\/+$/, '')) || 'download.bin';
            res.attachment(filename);
            res.setHeader('Content-Type', 'application/octet-stream');
            await sftp.get(remotePath, res);
        });
    } catch (error) {
        if (!res.headersSent) {
            res.status(400).json({ error: error.message || 'Unable to download file over SFTP' });
            return;
        }

        res.destroy(error);
    }
});

app.get('/api/sftp/download-folder', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    let temporaryDirectory = '';
    let cleanupStarted = false;

    const cleanupTemporaryDirectory = () => {
        if (cleanupStarted || !temporaryDirectory) {
            return;
        }

        cleanupStarted = true;
        fs.promises.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {
        });
    };

    try {
        const archiveSource = await withSftpClient(req, async (sftp, homePath) => {
            const remotePath = resolveRemotePath(homePath, req.query.path);
            const entryType = await sftp.exists(remotePath);

            if (!entryType) {
                throw new Error('Remote path not found');
            }

            if (entryType !== 'd') {
                throw new Error('Only folders can be downloaded as ZIP archives');
            }

            temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'guac-sftp-zip-'));
            const localSource = path.join(temporaryDirectory, 'source');
            await fs.promises.mkdir(localSource, { recursive: true });
            await sftp.downloadDir(remotePath, localSource);

            return {
                localSource,
                folderName: path.posix.basename(remotePath.replace(/\/+$/, '')) || 'folder'
            };
        });

        res.attachment(`${archiveSource.folderName}.zip`);
        res.setHeader('Content-Type', 'application/zip');
        res.on('close', cleanupTemporaryDirectory);
        res.on('finish', cleanupTemporaryDirectory);

        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        archive.on('error', (error) => {
            res.destroy(error);
        });

        archive.pipe(res);
        archive.directory(archiveSource.localSource, archiveSource.folderName);
        archive.finalize();
    } catch (error) {
        cleanupTemporaryDirectory();

        if (!res.headersSent) {
            res.status(400).json({ error: error.message || 'Unable to download folder over SFTP' });
            return;
        }

        res.destroy(error);
    }
});

app.delete('/api/sftp', requireAuth, async (req, res) => {
    if (!SFTP_ENABLED) {
        return res.status(404).json({ error: 'SFTP browser is disabled' });
    }

    try {
        await withSftpClient(req, async (sftp, homePath) => {
            const remotePath = resolveRemotePath(homePath, req.query.path);
            const entryType = await sftp.exists(remotePath);

            if (!entryType) {
                throw new Error('Remote path not found');
            }

            if (entryType === 'd') {
                await sftp.rmdir(remotePath, true);
                return;
            }

            await sftp.delete(remotePath);
        });

        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to delete remote file or folder' });
    }
});

app.get('/api/drive', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.query.path);
        const items = await listDriveDirectory(driveId, relativePath);

        res.json(buildDriveInfoPayload(relativePath, items));
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to read redirected drive' });
    }
});

app.post('/api/drive/folder', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.body.path);
        const folderName = sanitizeDriveEntryName(req.body.name);
        const folderRelativePath = getDriveChildPath(relativePath, folderName);

        await ensureDriveDirectory(driveId, folderRelativePath);

        res.status(201).json({
            ok: true,
            item: {
                name: folderName,
                path: folderRelativePath,
                type: 'directory'
            }
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to create folder' });
    }
});

app.post('/api/drive/upload/start', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.query.path);
        const sourceFilename = decodeDriveHeaderValue(req.get('x-file-name'));
        const fileSize = Number.parseInt(req.get('x-file-size') || '', 10);

        if (!sourceFilename) {
            return res.status(400).json({ error: 'Missing X-File-Name header' });
        }

        if (!Number.isFinite(fileSize) || fileSize < 0) {
            return res.status(400).json({ error: 'Missing or invalid X-File-Size header' });
        }

        if (fileSize > RDP_DRIVE_MAX_UPLOAD_BYTES) {
            return res.status(413).json({ error: 'File exceeds upload limit' });
        }

        await ensureDriveDirectory(driveId, relativePath);

        const uploadSession = await createDriveUploadSession(req, driveId, relativePath, sourceFilename, fileSize);

        res.status(201).json({
            ok: true,
            uploadId: uploadSession.uploadId,
            chunkSize: RDP_DRIVE_UPLOAD_CHUNK_BYTES,
            expectedSize: fileSize
        });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to start upload session' });
    }
});

app.post('/api/drive/upload/chunk', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    let uploadSession = null;
    let previousReceivedBytes = 0;
    let shouldRollbackChunk = false;

    try {
        await cleanupExpiredDriveUploadSessions();

        const uploadId = req.query.uploadId || req.get('x-upload-id');
        const chunkStart = Number.parseInt(req.get('x-chunk-start') || req.query.start || '', 10);
        const contentLength = Number.parseInt(req.get('content-length') || '', 10);

        uploadSession = getDriveUploadSession(req, uploadId);
        previousReceivedBytes = uploadSession.receivedBytes;

        if (!Number.isFinite(chunkStart) || chunkStart !== uploadSession.receivedBytes) {
            return res.status(409).json({
                error: 'Chunk offset mismatch',
                receivedBytes: uploadSession.receivedBytes
            });
        }

        if (!Number.isFinite(contentLength) || contentLength <= 0) {
            return res.status(400).json({ error: 'Missing or invalid chunk Content-Length header' });
        }

        if (contentLength > RDP_DRIVE_UPLOAD_CHUNK_BYTES) {
            return res.status(413).json({ error: 'Chunk exceeds allowed size' });
        }

        if (uploadSession.receivedBytes + contentLength > uploadSession.expectedSize) {
            return res.status(400).json({ error: 'Chunk exceeds expected file size' });
        }

        let chunkBytes = 0;
        req.on('data', (chunk) => {
            chunkBytes += chunk.length;

            if (uploadSession.receivedBytes + chunkBytes > uploadSession.expectedSize) {
                req.destroy(new Error('Chunk exceeds expected file size'));
            }
        });

        shouldRollbackChunk = true;
        const writeStream = fs.createWriteStream(uploadSession.tempPath, { flags: 'a' });
        await pipeline(req, writeStream);

        if (chunkBytes !== contentLength) {
            throw new Error('Incomplete chunk received');
        }

        uploadSession.receivedBytes += chunkBytes;
        uploadSession.updatedAt = Date.now();
        shouldRollbackChunk = false;

        res.json({
            ok: true,
            uploadId: uploadSession.uploadId,
            receivedBytes: uploadSession.receivedBytes,
            expectedSize: uploadSession.expectedSize,
            complete: uploadSession.receivedBytes === uploadSession.expectedSize
        });
    } catch (error) {
        if (uploadSession && shouldRollbackChunk) {
            await fs.promises.truncate(uploadSession.tempPath, previousReceivedBytes).catch(async () => {
                await cleanupDriveUploadSession(uploadSession.uploadId).catch(() => {
                });
            });
        }

        const statusCode = error.message === 'Chunk exceeds allowed size'
            ? 413
            : error.message === 'Chunk exceeds expected file size'
                ? 400
                : 400;

        res.status(statusCode).json({
            error: error.message || 'Unable to upload file chunk'
        });
    }
});

app.post('/api/drive/upload/complete', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    let reservedFile = null;

    try {
        await cleanupExpiredDriveUploadSessions();

        const uploadId = req.query.uploadId || req.get('x-upload-id');
        const uploadSession = getDriveUploadSession(req, uploadId);

        if (uploadSession.receivedBytes !== uploadSession.expectedSize) {
            return res.status(409).json({
                error: 'Upload is incomplete',
                receivedBytes: uploadSession.receivedBytes,
                expectedSize: uploadSession.expectedSize
            });
        }

        reservedFile = await reserveUniqueDriveFile(
            uploadSession.driveId,
            uploadSession.relativePath,
            uploadSession.sourceFilename
        );

        const writeStream = reservedFile.handle.createWriteStream();
        await pipeline(fs.createReadStream(uploadSession.tempPath), writeStream);
        await reservedFile.handle.close().catch(() => {
        });

        const fileStats = await fs.promises.stat(reservedFile.absolutePath);
        await cleanupDriveUploadSession(uploadSession.uploadId);

        res.status(201).json({
            ok: true,
            item: {
                name: reservedFile.filename,
                path: reservedFile.relativePath,
                type: 'file',
                size: fileStats.size,
                updatedAt: fileStats.mtime.toISOString()
            }
        });
    } catch (error) {
        await reservedFile?.handle?.close().catch(() => {
        });

        if (reservedFile?.absolutePath) {
            await fs.promises.rm(reservedFile.absolutePath, { force: true }).catch(() => {
            });
        }

        res.status(400).json({
            error: error.message || 'Unable to finalize uploaded file'
        });
    }
});

app.delete('/api/drive/upload', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        await cleanupExpiredDriveUploadSessions();

        const uploadId = req.query.uploadId || req.get('x-upload-id');
        getDriveUploadSession(req, uploadId);
        await cleanupDriveUploadSession(String(uploadId || ''));

        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to cancel upload session' });
    }
});

app.post('/api/drive/upload', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    let reservedFile = null;

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.query.path);
        const sourceFilename = decodeDriveHeaderValue(req.get('x-file-name'));
        const contentLength = Number.parseInt(req.get('content-length') || '', 10);

        console.log(`[Drive Upload] incoming upload: driveId=${driveId}, relativePath=${relativePath}, filename=${sourceFilename}, contentLength=${contentLength}`);

        if (!sourceFilename) {
            return res.status(400).json({ error: 'Missing X-File-Name header' });
        }

        if (Number.isFinite(contentLength) && contentLength > RDP_DRIVE_MAX_UPLOAD_BYTES) {
            return res.status(413).json({ error: 'File exceeds upload limit' });
        }

        reservedFile = await reserveUniqueDriveFile(driveId, relativePath, sourceFilename);
        console.log(`[Drive Upload] reserved file path -> ${reservedFile.absolutePath}`);

        let bytesReceived = 0;
        req.on('data', (chunk) => {
            bytesReceived += chunk.length;

            if (bytesReceived > RDP_DRIVE_MAX_UPLOAD_BYTES) {
                req.destroy(new Error('File exceeds upload limit'));
            }
        });

        const writeStream = reservedFile.handle.createWriteStream();
        await pipeline(req, writeStream);
        await reservedFile.handle.close().catch(() => {
        });

        const fileStats = await fs.promises.stat(reservedFile.absolutePath);

        console.log(`[Drive Upload] saved file: ${reservedFile.absolutePath} (${fileStats.size} bytes)`);

        res.status(201).json({
            ok: true,
            item: {
                name: reservedFile.filename,
                path: reservedFile.relativePath,
                type: 'file',
                size: fileStats.size,
                updatedAt: fileStats.mtime.toISOString()
            }
        });
    } catch (error) {
        await reservedFile?.handle?.close().catch(() => {
        });

        if (reservedFile?.absolutePath) {
            await fs.promises.rm(reservedFile.absolutePath, { force: true }).catch(() => {
            });
        }

        console.error('[Drive Upload] error:', error);
        const isFileTooLarge = error.message === 'File exceeds upload limit';
        res.status(isFileTooLarge ? 413 : 400).json({
            error: error.message || 'Unable to upload file'
        });
    }
});

app.get('/api/drive/download', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.query.path);
        const absolutePath = resolveDrivePath(driveId, relativePath);
        const fileStats = await fs.promises.stat(absolutePath);

        if (!fileStats.isFile()) {
            return res.status(400).json({ error: 'Only files can be downloaded' });
        }

        res.download(absolutePath, path.basename(absolutePath));
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to download file' });
    }
});

app.delete('/api/drive', requireAuth, async (req, res) => {
    if (!RDP_ENABLE_DRIVE) {
        return res.status(404).json({ error: 'Drive redirection is disabled' });
    }

    try {
        const driveId = getSessionDriveId(req);
        const relativePath = normalizeDriveRelativePath(req.query.path);

        if (!relativePath) {
            return res.status(400).json({ error: 'Refusing to delete the drive root' });
        }

        const absolutePath = resolveDrivePath(driveId, relativePath);
        await fs.promises.rm(absolutePath, {
            recursive: true,
            force: true
        });

        res.json({ ok: true });
    } catch (error) {
        res.status(400).json({ error: error.message || 'Unable to delete drive entry' });
    }
});

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        guacd: `${GUACD_HOST}:${GUACD_PORT}`,
        rdpTarget: `${RDP_HOST}:${RDP_PORT}`,
        driveShare: RDP_ENABLE_DRIVE ? DRIVE_STORAGE_ROOT : null,
        localFilesystemRoots: LOCAL_FS_ENABLED ? getAllowedLocalFsRoots() : [],
        sftpTarget: SFTP_ENABLED ? `${SFTP_HOST}:${SFTP_PORT}` : null
    });
});

// Build client options to provide sane defaults for RDP and secure token handling.
const clientOptions = {
    crypt: {
        cypher: TOKEN_CIPHER,
        key: tokenKey
    },
    maxInactivityTime: CLIENT_MAX_INACTIVITY_MS,
    // Default connection settings for RDP sessions
    connectionDefaultSettings: {
        rdp: {
            'security': RDP_SECURITY,
            'ignore-cert': true,
            ...buildRdpExperienceSettings(),
            ...buildRdpDriveSettings(),
            ...buildRdpPrinterSettings(),
            'enable-clipboard': true,
            'normalize-clipboard': RDP_CLIPBOARD_NORMALIZATION,
            'audio': RDP_AUDIO_TYPES
        }
    },
    // Allow safe query overrides (width/height/dpi/timezone/audio/video/image)
    allowedUnencryptedConnectionSettings: {
        rdp: ['width', 'height', 'dpi', 'timezone', 'audio', 'video', 'image']
    },
    // Logging level for guacamole-lite
    log: {
        level: process.env.GUAC_LOG_LEVEL || 'NORMAL'
    }
};

// Callbacks for validation and optional session registry (in-memory by default)
const sessionRegistry = new Map();

const callbacks = {
    processConnectionSettings: (settings, callback) => {
        (async () => {
            if (settings['expiration'] && Number(settings['expiration']) < Date.now()) {
                return callback(new Error('Token expired'));
            }

            if (RDP_ENABLE_DRIVE && settings.driveId && settings.connection) {
                console.log(`[Guacamole] processConnectionSettings: enabling drive for id=${settings.driveId}`);
                const driveRoot = await ensureDriveRootDirectory(settings.driveId);
                console.log(`[Guacamole] processConnectionSettings: host drive root -> ${driveRoot}`);

                // If GUACD_DRIVE_MOUNT is set, use the path visible inside the guacd process/container
                // so guacd can access the same files. Otherwise pass the host path.
                const guacdDriveRoot = GUACD_DRIVE_MOUNT
                    ? path.posix.join(GUACD_DRIVE_MOUNT.replace(/\\/g, '/'), settings.driveId)
                    : driveRoot;

                console.log(`[Guacamole] processConnectionSettings: guacd-visible drive root -> ${guacdDriveRoot}`);
                settings.connection['drive-path'] = guacdDriveRoot;
                settings.connection['drive-name'] = RDP_DRIVE_NAME;
                settings.connection['enable-drive'] = true;
                settings.connection['create-drive-path'] = true;
            }

            callback(null, settings);
        })().catch((error) => {
            callback(error);
        });
    },
    sessionRegistry
};

new GuacamoleLite(
    { server },
    {
        host: GUACD_HOST,
        port: GUACD_PORT
    },
    clientOptions,
    callbacks
);

server.listen(PORT, () => {
    console.log(`Web app listening on http://localhost:${PORT}`);
    console.log(`guacd target: ${GUACD_HOST}:${GUACD_PORT}`);
    console.log(
        `guacd inactivity timeout: ${
            GUACD_MAX_INACTIVITY_MS > 0
                ? `${GUACD_MAX_INACTIVITY_MS}ms`
                : 'disabled'
        }`
    );
    console.log(
        `viewer inactivity timeout: ${
            CLIENT_MAX_INACTIVITY_MS > 0
                ? `${CLIENT_MAX_INACTIVITY_MS}ms`
                : 'disabled'
        }`
    );
    console.log(`RDP target: ${RDP_HOST}:${RDP_PORT}`);
    console.log(`RDP security: viewer=${RDP_SECURITY}, validation=${RDP_VALIDATION_SECURITY}`);
    if (LOCAL_FS_ENABLED) {
        console.log(`Local filesystem roots: ${getAllowedLocalFsRoots().join(', ')}`);
    }
    if (SFTP_ENABLED) {
        console.log(`SFTP target: ${SFTP_HOST}:${SFTP_PORT}`);
    }
    if (RDP_ENABLE_DRIVE) {
        fs.promises.mkdir(DRIVE_STORAGE_ROOT, { recursive: true }).catch((error) => {
            console.error(`Failed to create drive storage root ${DRIVE_STORAGE_ROOT}:`, error.message);
        });
        console.log(`RDP drive share root: ${DRIVE_STORAGE_ROOT}`);
    }
});

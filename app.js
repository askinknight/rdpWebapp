const crypto = require('crypto');
const http = require('http');
const path = require('path');

const express = require('express');
const session = require('express-session');
const GuacamoleLite = require('guacamole-lite');

const PORT = Number(process.env.PORT || 3000);
const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT || 4822);
const RDP_HOST = process.env.RDP_HOST || '203.154.0.219';
const RDP_PORT = Number(process.env.RDP_PORT || 4490);
const RDP_RESIZE_METHOD = ['display-update', 'reconnect'].includes(process.env.RDP_RESIZE_METHOD)
    ? process.env.RDP_RESIZE_METHOD
    : 'display-update';
const RDP_CLIPBOARD_NORMALIZATION = ['preserve', 'unix', 'windows'].includes(process.env.RDP_CLIPBOARD_NORMALIZATION)
    ? process.env.RDP_CLIPBOARD_NORMALIZATION
    : 'windows';
const RDP_AUDIO_TYPES = String(process.env.RDP_AUDIO_TYPES || 'audio/L16,audio/L8')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
const RDP_MIC_BASE_TYPE = ['audio/L16', 'audio/L8'].includes(process.env.RDP_MIC_BASE_TYPE)
    ? process.env.RDP_MIC_BASE_TYPE
    : 'audio/L16';
const RDP_MIC_RATE = clampInteger(process.env.RDP_MIC_RATE, 44100, 8000, 192000);
const RDP_MIC_CHANNELS = clampInteger(process.env.RDP_MIC_CHANNELS, 2, 1, 2);
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-token-secret';

const TOKEN_CIPHER = 'AES-256-CBC';
const tokenKey = crypto.createHash('sha256').update(TOKEN_SECRET).digest();

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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
    express.static(path.join(__dirname, 'node_modules', 'guacamole-common-js', 'dist', 'cjs'))
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

    req.session.rdpAuth = {
        username,
        password
    };

    res.json({ ok: true, redirectTo: '/rdp' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true, redirectTo: '/login' });
    });
});

app.get('/api/session', (req, res) => {
    res.json({
        authenticated: Boolean(req.session.rdpAuth),
        username: req.session.rdpAuth?.username || null,
        targetHost: RDP_HOST
    });
});

app.get('/api/guacamole-token', (req, res) => {
    if (!req.session.rdpAuth) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { width, height, dpi, timezone } = getRequestedDisplaySettings(req);
    const validationOnly = String(req.query.mode || '').toLowerCase() === 'validate';
    const settings = {
        'hostname': RDP_HOST,
        'port': RDP_PORT,
        'username': req.session.rdpAuth.username,
        'password': req.session.rdpAuth.password,
        'width': width,
        'height': height,
        'dpi': dpi,
        'audio': validationOnly ? [] : RDP_AUDIO_TYPES,
        'color-depth': 24,
        'security': 'any',
        'ignore-cert': true,
        'resize-method': RDP_RESIZE_METHOD,
        'enable-touch': true,
        'enable-wallpaper': true,
        'enable-full-window-drag': true,
        'enable-desktop-composition': true,
        'enable-font-smoothing': true,
        'enable-menu-animations': true,
        'normalize-clipboard': RDP_CLIPBOARD_NORMALIZATION
    };

    applyTrueFlag(settings, 'disable-audio', validationOnly);
    applyTrueFlag(settings, 'enable-audio-input', !validationOnly);
    applyTrueFlag(settings, 'disable-copy', validationOnly);
    applyTrueFlag(settings, 'disable-paste', validationOnly);

    if (timezone) {
        settings.timezone = timezone;
    }

    const token = encryptToken({
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
        validationOnly,
        audioTypes: validationOnly ? [] : RDP_AUDIO_TYPES,
        microphoneMimetype: validationOnly
            ? null
            : buildRawAudioMimetype(RDP_MIC_BASE_TYPE, RDP_MIC_RATE, RDP_MIC_CHANNELS)
    });
});

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        guacd: `${GUACD_HOST}:${GUACD_PORT}`,
        rdpTarget: `${RDP_HOST}:${RDP_PORT}`
    });
});

new GuacamoleLite(
    { server },
    {
        host: GUACD_HOST,
        port: GUACD_PORT
    },
    {
        crypt: {
            cypher: TOKEN_CIPHER,
            key: tokenKey
        }
    }
);

server.listen(PORT, () => {
    console.log(`Web app listening on http://localhost:${PORT}`);
    console.log(`guacd target: ${GUACD_HOST}:${GUACD_PORT}`);
    console.log(`RDP target: ${RDP_HOST}:${RDP_PORT}`);
});

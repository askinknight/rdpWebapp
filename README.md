# Guacamole Lite RDP Web Client

โปรเจกต์นี้เป็นเว็บสำหรับเข้าใช้งาน RDP ผ่าน browser โดยใช้ Node.js/Express เป็น backend, `guacamole-lite` เป็น WebSocket gateway, `guacamole-common-js` เป็น client library ฝั่ง browser และ `guacd` เป็นตัวกลางที่เชื่อมต่อไปยัง RDP server จริง

ผู้ใช้เปิดหน้าเว็บ, login ด้วย RDP username/password, backend สร้าง encrypted token ให้ Guacamole, จากนั้น browser เปิด WebSocket ไปที่ Node.js และ Node.js ส่งต่อ session ไปยัง `guacd` เพื่อเชื่อม RDP target

## โครงสร้างไฟล์

```text
.
|-- app.js                  # Backend Express, auth/session, Guacamole token, file APIs
|-- package.json            # Node dependencies และ npm scripts
|-- docker-compose.yml      # guacd service และ shared-folder mount
|-- docker-compose.old.yml  # compose เดิมที่ใช้ image guacamole/guacd
|-- public/
|   |-- login.html          # หน้า login
|   |-- login.js            # logic login + validate RDP ก่อนเข้า viewer
|   |-- viewer.html         # หน้า RDP viewer
|   |-- viewer.js           # logic Guacamole viewer, keyboard/mouse, clipboard, file panel
|   `-- styles.css          # style ของหน้า login/viewer
|-- Cuddy/
|   |-- docker-compose.yml  # Caddy reverse proxy สำหรับ HTTPS
|   |-- Caddyfile           # reverse_proxy ไปยัง Node app
|   `-- certs/              # localhost cert/key
`-- test.json               # sample JSON data, ยังไม่ถูกเรียกใช้ในโค้ดหลัก
```

## ภาพรวมการทำงาน

```text
Browser
  | login.html/login.js
  | viewer.html/viewer.js
  v
Node.js Express app (app.js)
  | HTTP API: /api/login, /api/session, /api/guacamole-token, /api/drive
  | WebSocket: handled by guacamole-lite on the same HTTP server
  v
guacd
  v
RDP target: RDP_HOST:RDP_PORT
```

บริการหลักมี 3 ส่วน:

- Frontend: `public/login.html`, `public/login.js`, `public/viewer.html`, `public/viewer.js`
- Backend: `app.js`
- RDP gateway: `guacd` จาก `docker-compose.yml`

## วิธีรัน

ติดตั้ง dependency:

```powershell
npm install
```

เปิด `guacd`:

```powershell
docker compose up -d
```

ตั้งค่า RDP target แล้วรัน Node app:

```powershell
$env:RDP_HOST="203.154.0.219"
$env:RDP_PORT="4490"
$env:GUACD_HOST="127.0.0.1"
$env:GUACD_PORT="4822"
npm start
```

เปิดเว็บ:

```text
http://localhost:3000/login
```

ถ้าต้องการ HTTPS ด้วย Caddy ให้เข้าไปที่ `Cuddy/` แล้วรัน:

```powershell
docker compose up -d
```

หมายเหตุ: `Cuddy/Caddyfile` ตอนนี้ reverse proxy ไปที่ `192.168.101.3:3000` ถ้า Node app อยู่เครื่องอื่นหรือ port อื่น ต้องแก้ค่าในไฟล์นี้ก่อน

## Flow หลักของโปรเจกต์

### 1. เข้าเว็บ

1. Browser เปิด `/`
2. `app.get('/')` ตรวจ session
3. ถ้ายังไม่ login จะ redirect ไป `/login`
4. ถ้า login แล้วจะ redirect ไป `/rdp`

### 2. Login และ validate RDP

1. `login.js` รับ username/password และ `connectionType`
2. ส่ง `POST /api/login`
3. Backend เก็บข้อมูลไว้ใน `req.session.pendingRdpAuth`
4. ถ้า `connectionType=full` frontend จะขอ token แบบ validate จาก `GET /api/guacamole-token?mode=validate`
5. `login.js` ใช้ `Guacamole.WebSocketTunnel` และ `Guacamole.Client` ซ่อนอยู่หลังหน้า login เพื่อลองเชื่อม RDP จริง
6. ถ้า validate สำเร็จ จะเรียก `POST /api/login/confirm`
7. Backend ย้ายข้อมูลจาก `pendingRdpAuth` เป็น `rdpAuth`
8. Browser redirect ไป `/rdp`

สำหรับ `edge` และ `onlyoffice` backend ส่ง `validateMode=skip` เพราะ session จริงจะเปิดเป็น app mode ภายหลัง

### 3. เปิด RDP Viewer

1. `viewer.js` เรียก `startViewer()`
2. เรียก `GET /api/session` เพื่อดูว่า authenticated หรือไม่
3. เรียก `GET /api/guacamole-token` เพื่อขอ encrypted token
4. สร้าง `Guacamole.WebSocketTunnel` ไปที่ root WebSocket path `/`
5. สร้าง `Guacamole.Client`
6. ส่ง token ผ่าน `client.connect(...)`
7. `guacamole-lite` ใน backend decrypt token แล้วต่อไปยัง `guacd`
8. `guacd` เชื่อมต่อ RDP target ตาม settings ใน token

### 4. Shared drive / file transfer

ถ้า `RDP_ENABLE_DRIVE=true` backend จะสร้าง shared folder ต่อ session ด้วย `driveId` แยกผู้ใช้แต่ละ session ออกจากกัน

```text
Browser file panel
  -> /api/drive
  -> app.js writes to ./shared-folder/<driveId>
  -> guacd sees the same path as /shared-folder/<driveId>
  -> Windows RDP sees it as redirected drive name Shared_Folder
```

ตอน logout backend จะลบ session, cleanup upload session และลบ drive folder ของ session นั้น

## ความสัมพันธ์ Frontend กับ Backend

| Frontend function | API/backend ที่เกี่ยวข้อง | หน้าที่ |
|---|---|---|
| `login.js form submit` | `POST /api/login` | ส่ง username/password/connectionType เพื่อสร้าง pending login |
| `login.js buildTokenUrl("validate")` | `GET /api/guacamole-token?mode=validate` | ขอ token สำหรับ validate RDP credential |
| `login.js testConnection()` | WebSocket `/` ผ่าน `guacamole-lite` | สร้าง Guacamole client ชั่วคราวเพื่อลองเชื่อม RDP |
| `login.js clearFailedSession()` | `POST /api/logout` | ล้าง session เมื่อลองเชื่อมไม่สำเร็จ |
| `viewer.js startViewer()` | `GET /api/session`, `GET /api/guacamole-token` | โหลด session info และ token ก่อนเปิด RDP viewer |
| `viewer.js activeClient.connect()` | WebSocket `/` | เปิด session จริงไปยัง `guacd` |
| `viewer.js loadDriveShare()` | `GET /api/drive` | แสดงรายการไฟล์ใน redirected drive |
| `viewer.js uploadDriveFile()` | `/api/drive/upload/start`, `/chunk`, `/complete` | upload ไฟล์แบบแบ่ง chunk เข้า shared drive |
| `viewer.js deleteDriveEntry()` | `DELETE /api/drive` | ลบไฟล์/folder ใน shared drive |
| `viewer.js logout()` | `POST /api/logout` | ปิด session และ cleanup drive |
| `viewer.js onclipboard/onfile/onaudio` | Guacamole protocol stream | รับ clipboard, file, print/audio stream จาก remote session |

## Backend: `app.js`

### กลุ่ม config และ utility

| Function | หน้าที่ |
|---|---|
| `clampInteger(value, fallback, min, max)` | parse ตัวเลขจาก env/query และจำกัดช่วง |
| `parseBoolean(value, fallback)` | parse boolean จาก env เช่น `true`, `1`, `yes`, `off` |
| `noStore(req, res, next)` | ใส่ header กัน cache ให้ API ที่เกี่ยวกับ session/token |
| `encryptToken(payload)` | encrypt payload ด้วย `AES-256-CBC` ก่อนส่งให้ browser |
| `requireAuth(req, res, next)` | middleware บังคับว่าต้องมี `req.session.rdpAuth` |

### กลุ่ม RDP/Guacamole

| Function | หน้าที่ |
|---|---|
| `normalizeConnectionType(value)` | จำกัด connection type เป็น `full`, `edge`, หรือ `onlyoffice` |
| `applyAppLaunchSettings(settings, connectionType)` | ใส่ค่า `initial-program` หรือ `remote-app` สำหรับ Edge/ONLYOFFICE |
| `loadPatchedGuacamoleLite()` | patch inactivity timeout ของ `guacamole-lite` ก่อนใช้งาน |
| `getRequestedDisplaySettings(req)` | อ่าน width/height/dpi/timezone จาก query |
| `buildRawAudioMimetype(baseType, rate, channels)` | สร้าง mimetype สำหรับ microphone redirection |
| `buildRdpExperienceSettings()` | สร้าง settings เช่น color depth, touch, font smoothing |
| `buildRdpPrinterSettings()` | สร้าง settings สำหรับ printer redirection |
| `buildRdpDriveSettings()` | สร้าง settings สำหรับ redirected drive |

### กลุ่ม auth/session

| Function | หน้าที่ |
|---|---|
| `createDriveId()` | สร้าง id สำหรับ shared drive ของ session |
| `getPendingRdpAuth(req)` | อ่าน pending login และตรวจ TTL |
| `getSessionRdpAuth(req, options)` | อ่าน auth จาก session หรือ pending validation |
| `getSessionDriveId(req)` | อ่าน drive id ของ session ปัจจุบัน |
| `getSessionDriveIdsForCleanup(req)` | รวม drive id ที่ต้อง cleanup ตอน logout |

### กลุ่ม redirected drive

| Function | หน้าที่ |
|---|---|
| `getDriveRoot(driveId)` | path root ของ shared drive session |
| `normalizeDriveRelativePath(value)` | normalize path และกัน `.`/`..` |
| `isPathWithinDirectory(parent, child)` | ตรวจว่า path ยังอยู่ใน root ที่อนุญาต |
| `resolveDrivePath(driveId, relativePath)` | แปลง relative path เป็น absolute path ที่ปลอดภัย |
| `sanitizeDriveEntryName(name)` | clean ชื่อ file/folder |
| `ensureDriveRootDirectory(driveId)` | สร้าง root folder ของ session |
| `ensureDriveDirectory(driveId, relativePath)` | สร้าง folder ใน drive |
| `removeDriveRootDirectory(driveId)` | ลบ shared drive ของ session |
| `createDriveUploadSession(...)` | เปิด upload session แบบ chunk |
| `getDriveUploadSession(req, uploadId)` | ตรวจ upload id, session id และ drive id |
| `cleanupDriveUploadSession(uploadId)` | ลบ temp file ของ upload session |
| `cleanupExpiredDriveUploadSessions()` | ลบ upload session ที่เกิน TTL |
| `listDriveDirectory(driveId, relativePath)` | list file/folder ใน shared drive |
| `reserveUniqueDriveFile(...)` | จองชื่อไฟล์ไม่ให้ชน โดยเติม `(1)`, `(2)` |
| `buildDriveInfoPayload(...)` | สร้าง response สำหรับ file panel |

### กลุ่ม local filesystem

| Function | หน้าที่ |
|---|---|
| `getConfiguredLocalFsRoots()` | อ่าน root ที่อนุญาตจาก `LOCAL_FS_ROOTS` หรือ fallback เป็น drive/home |
| `getAllowedLocalFsRoots()` | filter เฉพาะ root ที่มีอยู่จริงและเป็น directory |
| `resolveAllowedLocalFsRoot(targetPath)` | หา root ที่ครอบ path |
| `resolveLocalFsPath(requestedPath)` | resolve path และกันออกนอก root |
| `getLocalFsParentPath(currentPath)` | หา parent path โดยไม่ย้อนออกนอก root |
| `sanitizeLocalFsEntryName(name)` | clean ชื่อ file/folder |
| `reserveUniqueLocalFsFile(...)` | จองชื่อไฟล์ไม่ให้ชน |
| `listLocalFsDirectory(currentPath)` | list local filesystem |

### กลุ่ม SFTP

| Function | หน้าที่ |
|---|---|
| `sanitizeRemoteEntryName(name)` | clean ชื่อ remote entry |
| `sanitizeRemotePath(value)` | normalize remote path เบื้องต้น |
| `isAbsoluteRemotePath(value)` | ตรวจ absolute path แบบ Unix/Windows |
| `normalizeRemotePath(value)` | normalize path สำหรับ remote |
| `resolveRemotePath(basePath, requestedPath)` | รวม base path กับ requested path |
| `joinRemotePath(parentPath, childName)` | join remote path อย่างปลอดภัย |
| `getRemoteParentPath(remotePath)` | หา parent path ของ remote |
| `buildSftpConnectionConfig(auth)` | สร้าง config SFTP จาก session auth |
| `resolveSftpHomePath(sftp)` | หา start directory ของ SFTP |
| `withSftpClient(req, callback)` | connect/disconnect SFTP แล้วเรียก callback |
| `buildSftpDirectoryListing(sftp, currentPath)` | list remote directory |
| `allocateRemoteUploadPath(...)` | จองชื่อ upload บน SFTP ไม่ให้ชน |

## API Routes

| Method | Path | Auth | หน้าที่ |
|---|---|---|---|
| `GET` | `/` | ไม่บังคับ | redirect ไป `/login` หรือ `/rdp` |
| `GET` | `/login` | ไม่บังคับ | ส่ง `public/login.html` |
| `GET` | `/rdp` | ต้อง login | ส่ง `public/viewer.html` |
| `POST` | `/api/login` | ไม่บังคับ | สร้าง pending RDP auth |
| `POST` | `/api/login/confirm` | pending auth | ยืนยัน login หลัง validate |
| `POST` | `/api/logout` | ไม่บังคับ | destroy session และ cleanup drive |
| `GET` | `/api/session` | ไม่บังคับ | ส่งข้อมูล session/capabilities |
| `GET` | `/api/debug/session` | ต้อง login | debug session และ driveId |
| `GET` | `/api/guacamole-token` | ต้องมี session/pending | สร้าง encrypted Guacamole token |
| `GET` | `/api/fs` | ต้อง login | list local filesystem |
| `POST` | `/api/fs/folder` | ต้อง login | สร้าง folder ใน local filesystem |
| `POST` | `/api/fs/upload` | ต้อง login | upload file เข้า local filesystem |
| `GET` | `/api/fs/download` | ต้อง login | download file จาก local filesystem |
| `GET` | `/api/fs/download-folder` | ต้อง login | download folder เป็น zip |
| `DELETE` | `/api/fs` | ต้อง login | delete file/folder ใน local filesystem |
| `GET` | `/api/sftp` | ต้อง login | list remote file ผ่าน SFTP |
| `POST` | `/api/sftp/folder` | ต้อง login | สร้าง remote folder |
| `POST` | `/api/sftp/upload` | ต้อง login | upload file ผ่าน SFTP |
| `GET` | `/api/sftp/download` | ต้อง login | download remote file |
| `GET` | `/api/sftp/download-folder` | ต้อง login | download remote folder เป็น zip |
| `DELETE` | `/api/sftp` | ต้อง login | delete remote file/folder |
| `GET` | `/api/drive` | ต้อง login | list redirected drive ของ session |
| `POST` | `/api/drive/folder` | ต้อง login | สร้าง folder ใน redirected drive |
| `POST` | `/api/drive/upload/start` | ต้อง login | เริ่ม chunked upload |
| `POST` | `/api/drive/upload/chunk` | ต้อง login | upload chunk |
| `POST` | `/api/drive/upload/complete` | ต้อง login | finalize upload |
| `DELETE` | `/api/drive/upload` | ต้อง login | cancel upload session |
| `POST` | `/api/drive/upload` | ต้อง login | upload file แบบ single request |
| `GET` | `/api/drive/download` | ต้อง login | download file จาก redirected drive |
| `DELETE` | `/api/drive` | ต้อง login | delete file/folder ใน redirected drive |
| `GET` | `/health` | ไม่บังคับ | health/config summary |

## Frontend: `login.js`

| Function | หน้าที่ |
|---|---|
| `showLoading()` / `hideLoading()` | เปิด/ปิด loading overlay ระหว่าง login |
| `showErrorPopup()` / `hideErrorPopup()` | แสดง error modal |
| `updateLoginButtonLabel()` | เปลี่ยน label ปุ่มตาม connection type |
| `buildWebSocketUrl()` | สร้าง `ws://` หรือ `wss://` ตาม protocol ปัจจุบัน |
| `buildTokenUrl(mode)` | สร้าง URL ขอ token พร้อม width/height/dpi/timezone |
| `mapConnectionError(error)` | แปลง Guacamole status เป็นข้อความที่ผู้ใช้เข้าใจ |
| `clearFailedSession()` | logout เมื่อ validate fail |
| `cleanupConnectionTest(testState)` | ปิด hidden Guacamole client ที่ใช้ validate |
| `testConnection(tokenData)` | ใช้ token แบบ validate เพื่อลอง connect RDP |
| `form submit handler` | flow login ทั้งหมด: `/api/login` -> validate -> `/api/login/confirm` -> `/rdp` |

## Frontend: `viewer.js`

### Connection และ Guacamole

| Function | หน้าที่ |
|---|---|
| `startViewer()` | entry point ของ viewer: ขอ session, ขอ token, เปิด WebSocket/RDP |
| `cleanupClient()` | ปิด client, tunnel, timer, keyboard, microphone และ clear display |
| `logout()` | เรียก `/api/logout` แล้วกลับ login |
| `handleReconnect()` | cleanup แล้วเรียก `startViewer()` ใหม่ |
| `buildConnectQuery(tokenData)` | สร้าง query สำหรับ `client.connect()` |
| `isConnected()` | ตรวจ state ของ Guacamole client |
| `scheduleAutomaticReconnect()` | ตั้ง reconnect เมื่อ tunnel/session หลุด |
| `reconnectIfTransportLooksStale()` | เช็ก tunnel ปิดแล้ว trigger reconnect |
| `setOverlay()` / `hideOverlay()` | ควบคุม overlay สถานะ connection |

### Input, resize, touch

| Function | หน้าที่ |
|---|---|
| `requestRemoteResize()` / `scheduleRemoteResize()` | แจ้งขนาดหน้าจอใหม่ให้ RDP |
| `updateDisplayScale()` | scale canvas/display ให้พอดีกับ viewport |
| `setupTouchInput()` | แปลง touch เป็น mouse/right click/scroll สำหรับ RDP |
| `sendMouseStateToRemote()` | ส่ง mouse state เข้า remote |
| `sendRemoteKeyTap()` / `sendRemoteKeyChord()` | ส่ง keyboard event เข้า remote |

### Clipboard, file stream, audio

| Function | หน้าที่ |
|---|---|
| `ensureClipboardBridgeInput()` | สร้าง input ซ่อนเพื่อช่วย native clipboard |
| `copyToLocalClipboard()` | copy ข้อความจาก remote ไป local clipboard |
| `sendClipboardTextToRemote()` | ส่ง text clipboard เข้า remote |
| `sendClipboardBlobToRemote()` | ส่ง blob/image clipboard เข้า remote |
| `handlePaste()` | จัดการ paste event ฝั่ง browser |
| `receiveRemoteFile()` | รับ file/print stream จาก remote แล้วทำ link open/download |
| `getSupportedAudioOutputTypes()` | ดู codec audio ที่ browser รองรับ |
| `ensureMicrophoneCapture()` | เริ่ม microphone redirection เมื่อ browser อนุญาต |

### File panel / redirected drive

| Function | หน้าที่ |
|---|---|
| `syncDriveCapabilities(tokenData)` | เปิด/ปิด file panel ตาม capability จาก backend |
| `loadDriveShare()` | เรียก `/api/drive` แล้ว render รายการไฟล์ |
| `refreshDriveShare()` | reload path ปัจจุบัน |
| `renderDriveList()` | วาด file/folder/action ใน panel |
| `uploadDriveFile()` | upload ไฟล์แบบ chunk ผ่าน `/api/drive/upload/*` |
| `handleDriveUploads()` | upload หลายไฟล์ต่อเนื่อง |
| `deleteDriveEntry()` | ลบ item ผ่าน `DELETE /api/drive` |
| `buildDriveApiUrl()` | สร้าง URL `/api/drive` |
| `buildDriveUploadUrl()` | สร้าง URL `/api/drive/upload...` |
| `buildDriveDownloadUrl()` | สร้าง URL download file |

## Environment Variables สำคัญ

| Variable | Default | ความหมาย |
|---|---|---|
| `PORT` | `3000` | port ของ Node app |
| `GUACD_HOST` | `127.0.0.1` | host ของ guacd |
| `GUACD_PORT` | `4822` | port ของ guacd |
| `GUACD_MAX_INACTIVITY_MS` | `0` | timeout guacd inactivity, `0` คือ disabled |
| `CLIENT_MAX_INACTIVITY_MS` | `0` | timeout client inactivity |
| `RDP_HOST` | `203.154.0.219` | RDP target host |
| `RDP_PORT` | `4490` | RDP target port |
| `RDP_SECURITY` | `any` | security mode: `any`, `nla`, `tls`, `rdp` |
| `RDP_VALIDATION_SECURITY` | `nla` ถ้า `RDP_SECURITY=any` | security mode ตอน validate |
| `RDP_RESIZE_METHOD` | `display-update` | resize mode: `display-update` หรือ `reconnect` |
| `RDP_APP_LAUNCH_MODE` | `initial-program` | app launch mode: `initial-program` หรือ `remote-app` |
| `RDP_EDGE_INITIAL_PROGRAM` | Edge exe path | path สำหรับเปิด Edge |
| `RDP_EDGE_REMOTE_APP` | `||msedge` | RemoteApp alias สำหรับ Edge |
| `RDP_ONLYOFFICE_INITIAL_PROGRAM` | ONLYOFFICE exe path | path สำหรับเปิด ONLYOFFICE |
| `RDP_ONLYOFFICE_REMOTE_APP` | `||DesktopEditors` | RemoteApp alias สำหรับ ONLYOFFICE |
| `RDP_CLIPBOARD_NORMALIZATION` | `windows` | normalize clipboard newline |
| `RDP_COLOR_DEPTH` | `32` | color depth |
| `RDP_AUDIO_TYPES` | `audio/L16,audio/L8` | audio mimetype ที่เสนอให้ browser |
| `RDP_MIC_BASE_TYPE` | `audio/L16` | base mimetype ของ microphone |
| `RDP_MIC_RATE` | `44100` | sample rate microphone |
| `RDP_MIC_CHANNELS` | `2` | channel microphone |
| `RDP_ENABLE_PRINTING` | `true` | เปิด printer redirection |
| `RDP_PRINTER_NAME` | `Browser Printer` | ชื่อ printer ใน remote |
| `RDP_ENABLE_DRIVE` | `true` | เปิด redirected drive |
| `RDP_DRIVE_NAME` | `Shared_Folder` | ชื่อ drive ใน remote |
| `RDP_DRIVE_STORAGE_ROOT` | `./shared-folder` | root folder ฝั่ง host |
| `GUACD_DRIVE_MOUNT` | `/shared-folder` | path ที่ guacd container เห็น |
| `RDP_DRIVE_MAX_UPLOAD_MB` | `1024` | max upload ต่อ file สำหรับ drive |
| `RDP_DRIVE_UPLOAD_CHUNK_MB` | `8` | chunk size upload |
| `RDP_DRIVE_UPLOAD_TTL_MS` | `3600000` | TTL ของ upload session |
| `LOCAL_FS_ENABLED` | `true` | เปิด local filesystem API |
| `LOCAL_FS_ROOTS` | ว่าง | root ที่ browse ได้ คั่นด้วย `;` หรือ newline |
| `LOCAL_FS_MAX_UPLOAD_MB` | `1024` | max upload local fs |
| `SFTP_ENABLED` | `false` | เปิด SFTP API |
| `SFTP_HOST` | เท่ากับ `RDP_HOST` | SFTP host |
| `SFTP_PORT` | `22` | SFTP port |
| `SFTP_START_PATH` | ว่าง | path เริ่มต้นหลัง connect SFTP |
| `SFTP_READY_TIMEOUT_MS` | `15000` | timeout connect SFTP |
| `SFTP_MAX_UPLOAD_MB` | `1024` | max upload SFTP |
| `LOGIN_VALIDATION_TTL_MS` | `300000` | TTL pending login |
| `SESSION_SECRET` | `change-me-session-secret` | secret ของ express-session |
| `TOKEN_SECRET` | `change-me-token-secret` | secret สำหรับ encrypt token |
| `GUAC_LOG_LEVEL` | `NORMAL` | log level ของ guacamole-lite |

## Docker และ Volume

`docker-compose.yml` เปิดเฉพาะ `guacd`:

```yaml
services:
  guacd:
    image: guacamole-server:latest
    ports:
      - "4822:4822"
    volumes:
      - ./shared-folder:/shared-folder
```

จุดสำคัญคือ `./shared-folder:/shared-folder` ต้องตรงกับ `RDP_DRIVE_STORAGE_ROOT` ฝั่ง Node และ `GUACD_DRIVE_MOUNT` ฝั่ง guacd เพื่อให้ browser upload ไฟล์แล้ว guacd เห็นไฟล์เดียวกัน

## Security Notes

- เปลี่ยน `SESSION_SECRET` และ `TOKEN_SECRET` ก่อนใช้งานจริง
- `cookie.secure` ใน `express-session` ตอนนี้เป็น `false`; ถ้าใช้งานผ่าน HTTPS จริงควรพิจารณาเปิดเป็น `true`
- `/api/debug/session` แสดง `driveId`; ควรลบหรือปิดใน production
- RDP username/password อยู่ใน server session ระหว่างใช้งาน ไม่ถูกเขียนลงไฟล์ แต่ยังควรดูแล session secret และ HTTPS ให้ดี
- `LOCAL_FS_ENABLED=true` ทำให้ backend browse filesystem ของเครื่องที่รัน Node ได้ ควรกำหนด `LOCAL_FS_ROOTS` ให้แคบที่สุด
- path helper หลัก เช่น `resolveDrivePath()` และ `resolveLocalFsPath()` มีการกัน path traversal โดยตรวจ path ให้อยู่ใน root ที่อนุญาต
- shared drive ต่อ session จะถูกลบเมื่อ logout แต่ถ้า process ถูก kill อาจมี folder ค้างใน `shared-folder`

## ข้อสังเกตจากโค้ดปัจจุบัน

- `viewer.js` สร้าง link `Download ZIP` ไปที่ `/api/drive/download-folder` แต่ backend ยังไม่มี route นี้ มีเฉพาะ `/api/fs/download-folder` และ `/api/sftp/download-folder`
- `viewer.js createDriveFolder()` เรียก `/api/fs/folder` ในขณะที่ list/upload/delete หลักของ panel ใช้ `/api/drive` ถ้าต้องการสร้าง folder ใน redirected drive ควรเปลี่ยนให้เรียก `/api/drive/folder`
- `Cuddy/Caddyfile` proxy ไปที่ `192.168.101.3:3000` แบบ fixed IP
- `docker-compose.yml` ใช้ image `guacamole-server:latest` ส่วน `docker-compose.old.yml` ใช้ `guacamole/guacd`; ต้องเลือก image ที่มีอยู่จริงใน environment ที่ deploy
- `test.json` ยังไม่ได้ถูก import หรือเรียกใช้จาก frontend/backend หลัก

## สรุปสั้น

โปรเจกต์นี้ทำหน้าที่เป็น RDP web gateway:

1. Express รับ login และเก็บ RDP credential ใน session
2. Express สร้าง encrypted Guacamole token จาก session
3. Browser ใช้ `guacamole-common-js` เปิด WebSocket กลับมาที่ Express
4. `guacamole-lite` รับ WebSocket แล้วส่งต่อไป `guacd`
5. `guacd` ต่อ RDP target และ stream หน้าจอ/keyboard/mouse/clipboard/file/audio กลับไปยัง browser
6. File panel ใช้ API ฝั่ง Express เพื่อจัดการ shared folder ที่ mount ให้ `guacd` เห็นเป็น redirected drive

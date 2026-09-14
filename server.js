const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');

const PORT = process.env.PORT || 8080;

// 取得本機在區域網路 (Wi-Fi) 下的內網 IP，方便大家手機連線
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// 建立簡易 HTTP 檔案伺服器，讓朋友的手機能直接打開網頁
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.json': 'application/json'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 查無此宮闈卷宗');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

const wss = new WebSocketServer({ server });

// 房間資料庫 (記憶體內)
// rooms[roomId] = { roomId, hostId, status: 'lobby'|'playing', members: [], gameState: null }
const rooms = {};

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify({
    type: 'ROOM_UPDATE',
    room: {
      roomId: room.roomId,
      hostId: room.hostId,
      status: room.status,
      members: room.members.map(m => ({
        userId: m.userId,
        charId: m.charId,
        name: m.name,
        isHost: m.userId === room.hostId
      })),
      gameState: room.gameState
    }
  });

  room.members.forEach(member => {
    if (member.ws && member.ws.readyState === WebSocket.OPEN) {
      member.ws.send(payload);
    }
  });
}

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

wss.on('connection', (ws) => {
  let currentUser = {
    userId: 'user_' + Math.random().toString(36).substring(2, 9),
    roomId: null
  };

  ws.send(JSON.stringify({ type: 'CONNECTED', userId: currentUser.userId }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        // 房主開房
        case 'CREATE_ROOM': {
          const roomId = generateRoomCode();
          currentUser.roomId = roomId;
          rooms[roomId] = {
            roomId,
            hostId: currentUser.userId,
            status: 'lobby',
            members: [{
              userId: currentUser.userId,
              charId: data.charId || 'wanpin',
              name: data.name || '小主1 (房主)',
              ws
            }],
            gameState: null
          };
          broadcastRoom(roomId);
          break;
        }

        // 朋友加入房間
        case 'JOIN_ROOM': {
          const targetRoomId = (data.roomId || '').trim().toUpperCase();
          const room = rooms[targetRoomId];
          if (!room) {
            ws.send(JSON.stringify({ type: 'ERROR', message: `未尋得房號【${targetRoomId}】之宮殿！` }));
            return;
          }
          if (room.status !== 'lobby') {
            ws.send(JSON.stringify({ type: 'ERROR', message: '該宮室已宴開對弈中，無法插殿。' }));
            return;
          }

          currentUser.roomId = targetRoomId;
          const existing = room.members.find(m => m.userId === currentUser.userId);
          if (!existing) {
            const takenCharIds = room.members.map(m => m.charId);
            const defaultChars = ['wanpin', 'huafei', 'huiguiren', 'anda_ying', 'huanghou'];
            const freeChar = defaultChars.find(id => !takenCharIds.includes(id)) || 'wanpin';
            room.members.push({
              userId: currentUser.userId,
              charId: freeChar,
              name: data.name || `小主${room.members.length + 1}`,
              ws
            });
          } else {
            existing.ws = ws;
          }
          broadcastRoom(targetRoomId);
          break;
        }

        // 更改扮演的小主
        case 'CHOOSE_CHAR': {
          const room = rooms[currentUser.roomId];
          if (!room || room.status !== 'lobby') return;
          const targetCharId = data.charId;
          const occupied = room.members.some(m => m.userId !== currentUser.userId && m.charId === targetCharId);
          if (occupied) {
            ws.send(JSON.stringify({ type: 'ERROR', message: '此位分已被同殿姊妹冊封，請另選高就！' }));
            return;
          }
          const me = room.members.find(m => m.userId === currentUser.userId);
          if (me) {
            me.charId = targetCharId;
            broadcastRoom(currentUser.roomId);
          }
          break;
        }

        // 房主啟奏正式開局
        case 'START_GAME': {
          const room = rooms[currentUser.roomId];
          if (!room || room.hostId !== currentUser.userId) return;
          if (room.members.length < 2) {
            ws.send(JSON.stringify({ type: 'ERROR', message: '至少需 2 位好友進入房間方可開局！' }));
            return;
          }
          room.status = 'playing';
          room.gameState = data.gameState; // 初始遊戲狀態
          broadcastRoom(currentUser.roomId);
          break;
        }

        // 同步每一步操作（行動、投毒、侍寢結算等）
        case 'SYNC_GAME_STATE': {
          const room = rooms[currentUser.roomId];
          if (!room || room.status !== 'playing') return;
          room.gameState = data.gameState;
          broadcastRoom(currentUser.roomId);
          break;
        }

        // 離開房間
        case 'LEAVE_ROOM': {
          handleLeave(currentUser, ws);
          break;
        }
      }
    } catch (e) {
      console.error('訊息解析錯誤：', e);
    }
  });

  ws.on('close', () => {
    handleLeave(currentUser, ws);
  });
});

function handleLeave(currentUser, ws) {
  if (!currentUser.roomId || !rooms[currentUser.roomId]) return;
  const roomId = currentUser.roomId;
  const room = rooms[roomId];
  room.members = room.members.filter(m => m.userId !== currentUser.userId);
  if (room.members.length === 0) {
    delete rooms[roomId];
    return;
  }
  if (room.hostId === currentUser.userId) {
    room.hostId = room.members[0].userId;
  }
  broadcastRoom(roomId);
}

server.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log('\n======================================================');
  console.log('👑 後宮甄嬛傳桌遊 · 聚會區網 WebSocket 伺服器已啟動！');
  console.log(`📡 本機瀏覽器請打開：http://localhost:${PORT}`);
  console.log(`📱 同一 Wi-Fi 下的好友手機請打開：http://${localIp}:${PORT}`);
  console.log('======================================================\n');
});
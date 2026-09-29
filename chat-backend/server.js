const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { ChatRoom, hashPassword } = require('./chat-room');

const ADMIN_PASSWORD = 'admin123';
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 8 * 1024 * 1024, // 8MB — đủ cho ảnh paste, tránh crash vì ảnh quá lớn
});

app.use(express.static(path.join(__dirname)));

// Toàn bộ dữ liệu chỉ lưu trong bộ nhớ (RAM) — mất khi tắt server, không cần database
const channels = new Map(); // channelId -> ChatRoom

function genChannelId() {
  return 'ch-' + Math.random().toString(36).slice(2, 10);
}

function createChannel(name, password) {
  const id = genChannelId();
  const room = new ChatRoom(id, name, io, hashPassword(password));
  channels.set(id, room);
  return room;
}

function getChannelList() {
  return Array.from(channels.values()).map((c) => c.toSummary());
}

function broadcastChannelList() {
  io.emit('channels:list', getChannelList());
}

io.on('connection', (socket) => {
  console.log('Người dùng kết nối:', socket.id);
  socket.userName = 'Ẩn danh';
  socket.isAdmin = false;
  socket.currentChannelId = null;

  socket.emit('channels:list', getChannelList());

  // ---- Đặt tên hiển thị (kèm mật khẩu quản trị tùy chọn) ----
  socket.on('setName', ({ name, adminPassword }) => {
    const trimmed = String(name || '').trim().slice(0, 30);
    socket.userName = trimmed || 'Ẩn danh';
    // Nhập đúng mật khẩu admin (cùng mật khẩu với xóa phòng) -> phiên này được gắn quyền quản trị viên
    socket.isAdmin = typeof adminPassword === 'string' && adminPassword.trim() === ADMIN_PASSWORD;
    socket.emit('nameSet', { name: socket.userName, isAdmin: socket.isAdmin });
  });

  // ---- Tạo phòng mới (bắt buộc có mật khẩu) ----
  socket.on('channel:create', ({ name, password }) => {
    const trimmedName = String(name || '').trim().slice(0, 50);
    const trimmedPassword = String(password || '').trim();

    if (!trimmedName) {
      socket.emit('error', 'Tên phòng không được để trống');
      return;
    }
    if (!trimmedPassword) {
      socket.emit('error', 'Mật khẩu không được để trống');
      return;
    }

    const room = createChannel(trimmedName, trimmedPassword);
    broadcastChannelList();
    socket.emit('channel:created', { channelId: room.id });
  });

  // ---- Tham gia 1 phòng (yêu cầu đúng mật khẩu, rời phòng cũ nếu có) ----
  socket.on('channel:join', ({ channelId, password }) => {
    const room = channels.get(channelId);
    if (!room) {
      socket.emit('error', 'Không tìm thấy phòng');
      return;
    }

    if (!room.checkPassword(password)) {
      socket.emit('channel:joinError', { channelId, message: 'Sai mật khẩu' });
      return;
    }

    // Nếu room chưa có object theo dõi readStatus thì tạo mới
    if (!room.readStatus) room.readStatus = {};

    // Rời kênh trước đó
    if (socket.currentChannelId && socket.currentChannelId !== channelId) {
      const prevRoom = channels.get(socket.currentChannelId);
      if (prevRoom) {
        prevRoom.removeMember(socket.id);
        // GỬI TIN NHẮN HỆ THỐNG RỜI PHÒNG
        prevRoom.messages.push({ id: Date.now(), type: 'system', text: `${socket.userName} đã rời phòng`, time: Date.now() });
        io.to(socket.currentChannelId).emit('channel:message', { 
          channelId: socket.currentChannelId, 
          message: prevRoom.messages[prevRoom.messages.length - 1] 
        });
        socket.leave(socket.currentChannelId);
      }
    }

    socket.join(channelId);
    socket.currentChannelId = channelId;
    room.addMember(socket.id, socket.id, socket.userName, socket.isAdmin);

    // GỬI TIN NHẮN HỆ THỐNG VÀO PHÒNG
    const joinMsg = { id: Date.now(), type: 'system', text: `${socket.userName} đã tham gia phòng`, time: Date.now() };
    room.messages.push(joinMsg);

    // Phát tin nhắn hệ thống cho những người ĐANG ở trong phòng (trừ người vừa vào)
    socket.to(channelId).emit('channel:message', { channelId, message: joinMsg });

    socket.emit('channel:joined', {
      channelId,
      channelName: room.name,
      messages: room.messages,
      members: Array.from(room.members.values()),
      readStatus: room.readStatus // Bổ sung danh sách đã xem
    });

    broadcastChannelList();
  });

  socket.on('channel:leave', () => {
    if (!socket.currentChannelId) return;
    const room = channels.get(socket.currentChannelId);
    if (room) {
      room.removeMember(socket.id);
      
      // GỬI TIN NHẮN HỆ THỐNG RỜI PHÒNG
      const leaveMsg = { id: Date.now(), type: 'system', text: `${socket.userName} đã rời phòng`, time: Date.now() };
      room.messages.push(leaveMsg);
      io.to(socket.currentChannelId).emit('channel:message', { channelId: socket.currentChannelId, message: leaveMsg });
      
      socket.leave(socket.currentChannelId);
    }
    socket.currentChannelId = null;
    broadcastChannelList();
  });

  // ---- Gửi tin nhắn (text và/hoặc ảnh, có thể kèm reply) ----
  socket.on('channel:message', ({ channelId, text, imageData, replyTo }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;

    if (imageData) {
      const approxBytes = imageData.length * 0.75; // ước lượng kích thước gốc từ chuỗi base64
      if (approxBytes > 6 * 1024 * 1024) {
        socket.emit('error', 'Ảnh quá lớn (giới hạn khoảng 6MB)');
        return;
      }
    }

    room.addMessage(socket.id, { text, imageData, replyTo });
    broadcastChannelList(); // cập nhật preview tin nhắn cuối trong danh sách kênh
  });

  // ---- Sửa tin nhắn (chủ tin nhắn hoặc admin) ----
  socket.on('channel:editMessage', ({ channelId, messageId, text }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    room.editMessage(socket.id, socket.isAdmin, messageId, text);
    broadcastChannelList();
  });

  // ---- Xoá tin nhắn (hard = xóa hẳn chỉ cho admin; quyền kiểm tra trong room) ----
  socket.on('channel:deleteMessage', ({ channelId, messageId, hard }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    room.deleteMessage(socket.id, socket.isAdmin, messageId, !!hard);
    broadcastChannelList();
  });

  // ---- Hoàn tác xóa tin nhắn (chủ tin nhắn hoặc admin) ----
  socket.on('channel:restoreMessage', ({ channelId, messageId }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    room.restoreMessage(socket.id, socket.isAdmin, messageId);
    broadcastChannelList();
  });

  // ---- Reaction ----
  socket.on('channel:reactMessage', ({ channelId, messageId, emoji }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    room.toggleReaction(socket.id, messageId, emoji);
  });

  // ---- Đang gõ ----
  socket.on('channel:typing', ({ channelId, isTyping }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    room.setTyping(socket.id, !!isTyping);
  });

  socket.on('channel:adminDelete', ({ channelId, adminPassword }) => {
    // 1. Kiểm tra mật khẩu
    if (adminPassword !== ADMIN_PASSWORD) {
      socket.emit('error', 'Sai mật khẩu Admin! Bạn không có quyền xóa phòng.');
      return;
    }

    // 2. Kiểm tra xem phòng có tồn tại không
    const room = channels.get(channelId);
    if (!room) {
      socket.emit('error', 'Phòng này không còn tồn tại.');
      return;
    }

    // 3. Thông báo cho tất cả người đang ở trong phòng đó biết phòng đã bị xóa (để họ văng ra)
    io.to(channelId).emit('channel:destroyed');

    // 4. Ép tất cả các socket đang join phòng này phải leave (rời đi)
    io.in(channelId).socketsLeave(channelId);

    // 5. Xóa khỏi bộ nhớ
    channels.delete(channelId);

    // 6. Cập nhật lại danh sách phòng cho tất cả mọi người
    broadcastChannelList();
  });

  // ---- Ngắt kết nối ----
  socket.on('disconnect', () => {
    console.log('Người dùng ngắt kết nối:', socket.id);
    if (socket.currentChannelId) {
      const room = channels.get(socket.currentChannelId);
      if (room) {
        room.removeMember(socket.id);
        
        const leaveMsg = { id: Date.now(), type: 'system', text: `${socket.userName} đã rời phòng`, time: Date.now() };
        room.messages.push(leaveMsg);
        io.to(socket.currentChannelId).emit('channel:message', { channelId: socket.currentChannelId, message: leaveMsg });
      }
      broadcastChannelList();
    }
  });
    socket.on('channel:markRead', ({ channelId, messageId }) => {
    const room = channels.get(channelId);
    if (!room || socket.currentChannelId !== channelId) return;
    
    if (!room.readStatus) room.readStatus = {};
    
    // Chỉ cập nhật nếu messageId này mới hơn (hoặc đơn giản là cứ ghi đè)
    room.readStatus[socket.id] = messageId;
    
    // Phát lại trạng thái đã xem cho cả phòng
    io.to(channelId).emit('channel:readStatus', {
      channelId,
      readStatus: room.readStatus
    });
  });
});

server.listen(3021, () => {
  console.log('💬 Chat server running on http://localhost:3021');
});

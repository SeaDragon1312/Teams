const crypto = require('crypto');

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function stripHtmlTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').trim();
}

let messageIdCounter = 1;

class ChatRoom {
  constructor(id, name, io, passwordHash) {
    this.id = id;
    this.name = name;
    this.io = io;
    this.passwordHash = passwordHash; // mọi phòng đều yêu cầu mật khẩu
    this.messages = []; // { id, userId, userName, text, imageData, time, editedAt, deleted, replyTo, reactions }
    this.members = new Map(); // socketId -> { userId, name }
    this.typingUsers = new Map(); // socketId -> name (đang gõ)
  }

  checkPassword(password) {
    return hashPassword(password) === this.passwordHash;
  }

  addMember(socketId, userId, name, isAdmin = false) {
    this.members.set(socketId, { userId, name, isAdmin });
    this.broadcastMembers();
  }

  removeMember(socketId) {
    this.members.delete(socketId);
    this.typingUsers.delete(socketId);
    this.broadcastMembers();
    this.broadcastTyping();
  }

  broadcastMembers() {
    const memberList = Array.from(this.members.values());
    this.io.to(this.id).emit('channel:members', {
      channelId: this.id,
      members: memberList,
      count: memberList.length,
    });
  }

  findMessage(messageId) {
    return this.messages.find((m) => m.id === messageId);
  }

  // ===== GỬI TIN NHẮN (text và/hoặc ảnh, có thể kèm reply) =====
  addMessage(socketId, { text, imageData, replyTo } = {}) {
    const member = this.members.get(socketId);
    if (!member) return null;

    const trimmedText = String(text || '').trim().slice(0, 20000);
    const hasImage = typeof imageData === 'string' && imageData.startsWith('data:image/');

    if (!trimmedText && !hasImage) return null;

    const message = {
      id: messageIdCounter++,
      userId: member.userId,
      userName: member.name,
      isAdmin: !!member.isAdmin,
      text: trimmedText,
      imageData: hasImage ? imageData : null,
      time: Date.now(),
      editedAt: null,
      deleted: false,
      replyTo: replyTo
        ? {
            id: replyTo.id,
            userName: String(replyTo.userName || '').slice(0, 30),
            text: String(replyTo.text || '').slice(0, 200),
            hasImage: !!replyTo.hasImage,
          }
        : null,
      reactions: {},
    };
    this.messages.push(message);
    if (this.messages.length > 500) this.messages.shift(); // giới hạn lịch sử trong bộ nhớ

    this.io.to(this.id).emit('channel:message', {
      channelId: this.id,
      message,
    });

    this.setTyping(socketId, false);

    return message;
  }

  // ===== SỬA TIN NHẮN (chủ tin nhắn hoặc quản trị viên) =====
  editMessage(socketId, isAdmin, messageId, newText) {
    const member = this.members.get(socketId);
    if (!member) return;

    const msg = this.findMessage(messageId);
    if (!msg || !msg.userId || msg.deleted) return;
    if (!isAdmin && msg.userId !== member.userId) return;

    const trimmed = String(newText || '').trim().slice(0, 20000);
    if (!trimmed && !msg.imageData) return; // không cho sửa thành rỗng nếu không có ảnh kèm theo

    msg.text = trimmed;
    msg.editedAt = Date.now();

    this.io.to(this.id).emit('channel:messageEdited', {
      channelId: this.id,
      messageId: msg.id,
      text: msg.text,
      editedAt: msg.editedAt,
    });
  }

  // ===== XOÁ TIN NHẮN =====
  // hard = false: xóa tạm thời — giữ nguyên nội dung trong bộ nhớ để hoàn tác được
  //               (chủ tin nhắn hoặc quản trị viên)
  // hard = true : xóa hẳn khỏi lịch sử, không hoàn tác được (chỉ quản trị viên)
  deleteMessage(socketId, isAdmin, messageId, hard = false) {
    const member = this.members.get(socketId);
    if (!member) return;

    const msg = this.findMessage(messageId);
    if (!msg || !msg.userId || msg.deleted) return;

    if (hard) {
      if (!isAdmin) return;
      this.messages.splice(this.messages.indexOf(msg), 1);
      this.io.to(this.id).emit('channel:messageRemoved', {
        channelId: this.id,
        messageId: msg.id,
      });
      return;
    }

    if (!isAdmin && msg.userId !== member.userId) return;

    msg.deleted = true;
    this.io.to(this.id).emit('channel:messageDeleted', {
      channelId: this.id,
      messageId: msg.id,
    });
  }

  // ===== HOÀN TÁC XOÁ (chỉ tin bị xóa tạm thời; chủ tin nhắn hoặc quản trị viên) =====
  restoreMessage(socketId, isAdmin, messageId) {
    const member = this.members.get(socketId);
    if (!member) return;

    const msg = this.findMessage(messageId);
    if (!msg || !msg.userId || !msg.deleted) return;
    if (!isAdmin && msg.userId !== member.userId) return;

    msg.deleted = false;
    this.io.to(this.id).emit('channel:messageRestored', {
      channelId: this.id,
      messageId: msg.id,
    });
  }

  // ===== BẬT/TẮT REACTION (mỗi người chỉ giữ 1 lần cho mỗi emoji) =====
  toggleReaction(socketId, messageId, emoji) {
    const member = this.members.get(socketId);
    if (!member) return;

    const msg = this.findMessage(messageId);
    if (!msg || msg.deleted) return;

    const cleanEmoji = String(emoji || '').trim();
    if (!cleanEmoji) return;

    if (!msg.reactions[cleanEmoji]) msg.reactions[cleanEmoji] = [];

    const idx = msg.reactions[cleanEmoji].indexOf(member.userId);
    if (idx >= 0) {
      msg.reactions[cleanEmoji].splice(idx, 1);
      if (msg.reactions[cleanEmoji].length === 0) delete msg.reactions[cleanEmoji];
    } else {
      msg.reactions[cleanEmoji].push(member.userId);
    }

    this.io.to(this.id).emit('channel:messageReaction', {
      channelId: this.id,
      messageId: msg.id,
      reactions: msg.reactions,
    });
  }

  setTyping(socketId, isTyping) {
    const member = this.members.get(socketId);
    if (!member) return;

    if (isTyping) {
      this.typingUsers.set(socketId, member.name);
    } else {
      this.typingUsers.delete(socketId);
    }
    this.broadcastTyping();
  }

  broadcastTyping() {
    this.io.to(this.id).emit('channel:typing', {
      channelId: this.id,
      typingNames: Array.from(this.typingUsers.values()),
    });
  }

  toSummary() {
    const last = this.messages.length ? this.messages[this.messages.length - 1] : null;
    let lastMessage = null;
    if (last) {
      let previewText;
      if (last.deleted) previewText = 'Tin nhắn đã bị xoá';
      else if (last.text) previewText = stripHtmlTags(last.text);
      else if (last.imageData) previewText = '📷 Đã gửi một hình ảnh';
      else previewText = '';
      lastMessage = { userName: last.userName, text: previewText, time: last.time };
    }
    return {
      id: this.id,
      name: this.name,
      memberCount: this.members.size,
      lastMessage,
      hasPassword: true, // mọi phòng trong bản này đều yêu cầu mật khẩu
    };
  }
}

module.exports = { ChatRoom, hashPassword };

// Smoke test tạm thời cho tính năng undo/hard-delete + phân quyền admin.
// Chạy: node _smoke-test.js  (tự khởi động server, tự tắt)
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { io } = require('D:/Users/v179522/Documents/teams/chat-frontend/chat-app/node_modules/socket.io-client');

const SERVER = 'http://localhost:3021';
let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) {
    passed++;
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.log('  FAIL  ' + label);
  }
};

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    s.once('connect', () => {
      clearTimeout(t);
      resolve(s);
    });
  });
}

function waitFor(socket, event, ms = 2000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off(event, fn);
      resolve(null);
    }, ms);
    const fn = (data) => {
      clearTimeout(t);
      socket.off(event, fn);
      resolve(data);
    };
    socket.on(event, fn);
  });
}

// Giống waitFor nhưng bỏ qua các event không khớp điều kiện (tránh bắt nhầm
// event cũ còn nằm trong hàng đợi của socket, ví dụ tin hệ thống vào/rời phòng)
function waitForMatch(socket, event, predicate, ms = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off(event, fn);
      resolve(null);
    }, ms);
    const fn = (data) => {
      if (!predicate(data)) return; // giữ listener, chờ event khớp
      clearTimeout(t);
      socket.off(event, fn);
      resolve(data);
    };
    socket.on(event, fn);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. Kiểm tra cổng 3021 rảnh
  const portFree = await new Promise((resolve) => {
    const sock = net.connect(3021, '127.0.0.1');
    sock.on('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(true));
  });
  if (!portFree) {
    console.log('PORT_BUSY: cổng 3021 đang bị chiếm (có server đang chạy?) — tắt server rồi chạy lại test.');
    process.exit(2);
  }

  // 2. Khởi động server
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'pipe' });
  server.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('EADDRINUSE')) {
      console.log('EADDRINUSE trên server test');
      process.exit(2);
    }
  });
  const started = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server không khởi động kịp')), 8000);
    server.stdout.on('data', (d) => {
      if (d.toString().includes('running on')) {
        clearTimeout(t);
        resolve(true);
      }
    });
  });
  if (!started) throw new Error('server không chạy');
  console.log('Server test đã chạy');

  // 3. Kết nối 3 client
  const admin = await connect();
  const bob = await connect();
  const carol = await connect();

  // 4. Nhận diện admin
  const pNameAdmin = waitFor(admin, 'nameSet');
  admin.emit('setName', { name: 'Admin', adminPassword: 'admin123' });
  const nameSetAdmin = await pNameAdmin;
  ok(!!nameSetAdmin && nameSetAdmin.isAdmin === true, 'Admin nhập đúng mật khẩu -> nameSet.isAdmin = true');

  const pNameWrong = waitFor(carol, 'nameSet');
  carol.emit('setName', { name: 'Carol', adminPassword: 'sai-pass' });
  const nameSetWrong = await pNameWrong;
  ok(!!nameSetWrong && nameSetWrong.isAdmin === false, 'Nhập sai mật khẩu admin -> không thành admin');

  const pNameBob = waitFor(bob, 'nameSet');
  bob.emit('setName', { name: 'Bob' });
  await pNameBob;

  // 5. Tạo phòng + vào phòng
  const pCreated = waitFor(bob, 'channel:created');
  bob.emit('channel:create', { name: 'TestRoom', password: 'pw123' });
  const { channelId } = await pCreated;
  ok(!!channelId, 'Tạo phòng thành công');

  const pJoinA = waitFor(admin, 'channel:joined');
  const pJoinB = waitFor(bob, 'channel:joined');
  const pJoinC = waitFor(carol, 'channel:joined');
  admin.emit('channel:join', { channelId, password: 'pw123' });
  bob.emit('channel:join', { channelId, password: 'pw123' });
  carol.emit('channel:join', { channelId, password: 'pw123' });
  const joinedB = await pJoinB;
  const joinedC = await pJoinC;
  await pJoinA;

  const adminMember = (joinedC.members || []).find((m) => m.name === 'Admin');
  ok(!!adminMember && adminMember.isAdmin === true, 'Danh sách thành viên có đánh dấu isAdmin');

  // 6. Gửi tin nhắn: Bob -> msg1, Admin -> msg2 (quan sát từ socket Carol — không dính race)
  const pMsg1 = waitForMatch(carol, 'channel:message', (d) => d.message && d.message.userId === bob.id);
  bob.emit('channel:message', { channelId, text: 'hello from Bob' });
  const msg1 = (await pMsg1).message;
  const pMsg2 = waitForMatch(carol, 'channel:message', (d) => d.message && d.message.userId === admin.id);
  admin.emit('channel:message', { channelId, text: 'hello from Admin' });
  const msg2 = (await pMsg2).message;
  ok(msg2.isAdmin === true, 'Tin nhắn của admin có cờ isAdmin');

  // 7. Carol (người thường) thử xóa tin của Bob -> bị từ chối
  let deletedEvt = null;
  const onDel = (d) => (deletedEvt = d);
  bob.on('channel:messageDeleted', onDel);
  carol.emit('channel:deleteMessage', { channelId, messageId: msg1.id, hard: false });
  await sleep(500);
  ok(deletedEvt === null, 'Người thường không xóa được tin của người khác');
  bob.off('channel:messageDeleted', onDel);

  // 8. Admin xóa TẠM tin của Bob
  const pDel1 = waitFor(bob, 'channel:messageDeleted');
  admin.emit('channel:deleteMessage', { channelId, messageId: msg1.id, hard: false });
  const del1 = await pDel1;
  ok(!!del1 && del1.messageId === msg1.id, 'Admin xóa tạm được tin của người khác');

  // 9. Carol thử hoàn tác tin của Bob -> bị từ chối
  let restoredEvt = null;
  const onRest = (d) => (restoredEvt = d);
  bob.on('channel:messageRestored', onRest);
  carol.emit('channel:restoreMessage', { channelId, messageId: msg1.id });
  await sleep(500);
  ok(restoredEvt === null, 'Người thường không hoàn tác được tin của người khác');
  bob.off('channel:messageRestored', onRest);

  // 10. Bob hoàn tác tin của chính mình
  const pRest1 = waitFor(bob, 'channel:messageRestored');
  bob.emit('channel:restoreMessage', { channelId, messageId: msg1.id });
  const rest1 = await pRest1;
  ok(!!rest1 && rest1.messageId === msg1.id, 'Chủ tin hoàn tác được tin của chính mình');

  // 11. Admin xóa tạm + hoàn tác tin của người khác
  const pDel2 = waitFor(bob, 'channel:messageDeleted');
  admin.emit('channel:deleteMessage', { channelId, messageId: msg1.id, hard: false });
  await pDel2;
  const pRest2 = waitFor(bob, 'channel:messageRestored');
  admin.emit('channel:restoreMessage', { channelId, messageId: msg1.id });
  const rest2 = await pRest2;
  ok(!!rest2 && rest2.messageId === msg1.id, 'Admin hoàn tác được tin của người khác');

  // 12. Nội dung tin giữ nguyên sau xóa tạm + hoàn tác (kiểm tra qua rejoin)
  carol.emit('channel:leave');
  await sleep(300);
  const pRejoin = waitFor(carol, 'channel:joined');
  carol.emit('channel:join', { channelId, password: 'pw123' });
  const rejoined = await pRejoin;
  const m1 = (rejoined.messages || []).find((m) => m.id === msg1.id);
  ok(!!m1 && m1.deleted === false && m1.text === 'hello from Bob', 'Nội dung tin giữ nguyên sau xóa tạm + hoàn tác');

  // 13. Carol gửi msg3; Bob (người thường) thử XÓA HẲN -> bị từ chối
  const pMsg3 = waitForMatch(bob, 'channel:message', (d) => d.message && d.message.userId === carol.id);
  carol.emit('channel:message', { channelId, text: 'hello from Carol' });
  const msg3 = (await pMsg3).message;

  let removedEvt = null;
  const onRem = (d) => (removedEvt = d);
  bob.on('channel:messageRemoved', onRem);
  bob.emit('channel:deleteMessage', { channelId, messageId: msg3.id, hard: true });
  await sleep(500);
  ok(removedEvt === null, 'Người thường không XÓA HẲN được tin của ai');
  bob.off('channel:messageRemoved', onRem);

  // 14. Admin XÓA HẲN tin của Carol
  const pRem1 = waitFor(bob, 'channel:messageRemoved');
  admin.emit('channel:deleteMessage', { channelId, messageId: msg3.id, hard: true });
  const rem1 = await pRem1;
  ok(!!rem1 && rem1.messageId === msg3.id, 'Admin xóa hẳn được tin của người khác');

  // 15. Tin bị xóa hẳn biến mất khỏi lịch sử (kiểm tra qua rejoin)
  bob.emit('channel:leave');
  await sleep(300);
  const pRejoin2 = waitFor(bob, 'channel:joined');
  bob.emit('channel:join', { channelId, password: 'pw123' });
  const rejoined2 = await pRejoin2;
  ok(!(rejoined2.messages || []).find((m) => m.id === msg3.id), 'Tin bị xóa hẳn biến mất khỏi lịch sử');

  // 16. Xóa hẳn tin của chính admin (msg2)
  const pRem2 = waitFor(bob, 'channel:messageRemoved');
  admin.emit('channel:deleteMessage', { channelId, messageId: msg2.id, hard: true });
  const rem2 = await pRem2;
  ok(!!rem2 && rem2.messageId === msg2.id, 'Admin xóa hẳn được cả tin của chính mình');

  // 17. Carol (người thường) thử sửa tin của Bob -> bị từ chối
  let editedEvt = null;
  const onEdit = (d) => (editedEvt = d);
  bob.on('channel:messageEdited', onEdit);
  carol.emit('channel:editMessage', { channelId, messageId: msg1.id, text: 'carol sửa trộm' });
  await sleep(500);
  ok(editedEvt === null, 'Người thường không sửa được tin của người khác');
  bob.off('channel:messageEdited', onEdit);

  // 18. Admin sửa tin của Bob
  const pEdit1 = waitFor(bob, 'channel:messageEdited');
  admin.emit('channel:editMessage', { channelId, messageId: msg1.id, text: 'admin đã sửa tin này' });
  const edit1 = await pEdit1;
  ok(!!edit1 && edit1.text === 'admin đã sửa tin này', 'Admin sửa được tin của người khác');

  // 19. Người gửi không đổi sau khi admin sửa (kiểm tra qua rejoin)
  carol.emit('channel:leave');
  await sleep(300);
  const pRejoin3 = waitFor(carol, 'channel:joined');
  carol.emit('channel:join', { channelId, password: 'pw123' });
  const rejoined3 = await pRejoin3;
  const m1b = (rejoined3.messages || []).find((m) => m.id === msg1.id);
  ok(!!m1b && m1b.text === 'admin đã sửa tin này' && m1b.userName === 'Bob' && m1b.isAdmin === false, 'Người gửi không đổi sau khi admin sửa');

  // 20. Tin nhắn dài (15000 ký tự) gửi đầy đủ (trước đây bị cắt ở 4000)
  const longText = 'A'.repeat(15000);
  const pMsgLong = waitForMatch(carol, 'channel:message', (d) => d.message && d.message.userId === bob.id && (d.message.text || '').length > 10000);
  bob.emit('channel:message', { channelId, text: longText });
  const msgLong = (await pMsgLong).message;
  ok(!!msgLong && msgLong.text.length === 15000, 'Tin nhắn dài 15000 ký tự gửi đầy đủ');

  // Dọn dẹp
  [admin, bob, carol].forEach((s) => s.disconnect());
  server.kill();
  console.log(`\nKẾT QUẢ: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('Test lỗi:', err.message);
  process.exit(1);
});

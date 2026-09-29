import { Component, OnInit, OnDestroy, AfterViewChecked, ViewChild, ElementRef, inject, PLATFORM_ID, HostListener } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocketService } from '../services/socket.service';

interface ReplySnapshot {
  id: number;
  userName: string;
  text: string;
  hasImage: boolean;
}

interface ChatMessage {
  id: number;
  userId: string;
  userName: string;
  isAdmin?: boolean;
  text: string;
  imageData?: string | null;
  time: number;
  editedAt?: number | null;
  deleted?: boolean;
  replyTo?: ReplySnapshot | null;
  reactions?: { [emoji: string]: string[] };
  type?: 'system' | 'user'; // <--- THÊM DÒNG NÀY
}

interface ChannelSummary {
  id: string;
  name: string;
  memberCount: number;
  hasPassword: boolean;
  lastMessage: { userName: string; text: string; time: number } | null;
}

interface Member {
  userId: string;
  name: string;
  isAdmin?: boolean;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.scss',
})
export class ChatComponent implements OnInit, OnDestroy, AfterViewChecked {
  private platformId = inject(PLATFORM_ID);

  // ===== ĐĂNG NHẬP =====
  nameEntered = false;
  nameInput = '';
  adminPasswordInput = '';
  myName = '';
  isAdmin = false;

  // ===== DANH SÁCH PHÒNG (giờ nằm trong FAB) =====
  channels: ChannelSummary[] = [];
  channelSearch = '';
  fabOpen = false;

  // ===== PHÒNG HIỆN TẠI =====
  currentChannelId = '';
  currentChannelName = '';
  messages: ChatMessage[] = [];
  members: Member[] = [];
  typingNames: string[] = [];
  isLoadingChannel = false;

  // ===== TẠO PHÒNG MỚI (bắt buộc mật khẩu) =====
  showCreateChannelModal = false;
  newChannelName = '';
  newChannelPassword = '';

  // ===== NHẬP MẬT KHẨU ĐỂ VÀO PHÒNG =====
  passwordPromptChannelId: string | null = null;
  passwordPromptChannelName = '';
  passwordPromptInput = '';
  passwordPromptError = '';

  // ===== SOẠN TIN NHẮN =====
  pendingImage: string | null = null;
  replyingTo: ReplySnapshot | null = null;
  private typingStopTimeout: any;
  private isCurrentlyTyping = false;

  // ===== HOVER / MENU TRÊN TIN NHẮN =====
  hoveredMessageId: number | null = null;
  reactionPickerFor: number | null = null;
  hasComposerContent = false;
  quickReactions = ['👍', '❤️', '😆', '😲'];
  extraReactions = [
    // Nhóm Buồn / Chia sẻ
    '😢', '😭', '💔', '🥺', 
    // Nhóm Tương tác / Cổ vũ
    '👏', '🎉', '🔥', '💯', '🙏', '🙌', 
    // Nhóm Yêu thương / Gắn kết
    '🥰', '😍', '✨', '🤝', 
    // Nhóm Hài hước / Bất ngờ
    '🤣', '🤔', '😎', '😱', 
    // Nhóm Tiêu cực / Không thích
    '😡', '👎', '💩', '🤡',
    '❓', '🔥', '💀'
  ];

  // ===== SỬA TIN NHẮN (chủ tin hoặc admin; giữ định dạng HTML gốc) =====
  editingMessageId: number | null = null;
  editingHtml = '';

  // ===== PANEL THÀNH VIÊN =====
  showMembersPanel = false;

  // ===== XEM ẢNH PHÓNG TO =====
  viewerImage: string | null = null;
  viewerScale = 1;
  viewerOffsetX = 0;
  viewerOffsetY = 0;
  private isDraggingViewer = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // ===== TRẠNG THÁI ĐÃ XEM =====
  readStatus: { [userId: string]: number } = {}; 

  // ===== CUỘN THÔNG MINH + THÔNG BÁO TIN NHẮN MỚI =====
  newMessageBannerVisible = false;
  newMessageCount = 0;
  private pendingScrollToBottom = false;

  @ViewChild('messagesEl') messagesEl?: ElementRef<HTMLDivElement>;
  @ViewChild('messageInputEl') messageInputEl?: ElementRef<HTMLDivElement>;
  @ViewChild('editInputEl') editInputEl?: ElementRef<HTMLDivElement>;

  private lastMessageCount = 0;

  constructor(private socketService: SocketService) {}

  ngOnInit() {
    if (!isPlatformBrowser(this.platformId)) return;

    const socket = this.socketService.socket;
    if (!socket) return;

    socket.on('channels:list', (list: ChannelSummary[]) => {
      this.channels = list;
    });

    socket.on('nameSet', (data: { name: string; isAdmin?: boolean }) => {
      this.isAdmin = !!data.isAdmin;
    });

    socket.on('channel:created', (data: { channelId: string }) => {
      this.socketService.joinChannel(data.channelId, this.newChannelPassword);
      this.showCreateChannelModal = false;
      this.newChannelName = '';
      this.newChannelPassword = '';
    });

    socket.on('channel:joined', (data: any) => {
      this.currentChannelId = data.channelId;
      this.currentChannelName = data.channelName;
      this.messages = data.messages || [];
      this.members = data.members || [];
      this.readStatus = data.readStatus || {};
      this.isLoadingChannel = false;
      this.lastMessageCount = -1;
      this.passwordPromptChannelId = null;
      this.passwordPromptError = '';
      this.newMessageBannerVisible = false;
      this.newMessageCount = 0;
      this.pendingScrollToBottom = true;
      this.fabOpen = false;
      this.markLastMessageRead();
    });

    socket.on('channel:joinError', (data: any) => {
      if (data.channelId === this.passwordPromptChannelId) {
        this.passwordPromptError = data.message || 'Sai mật khẩu';
      }
      this.isLoadingChannel = false;
    });

    socket.on('channel:message', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const wasNearBottom = this.isNearBottom();
      const isMine = data.message.userId === this.socketService.myId;
      this.messages.push(data.message);

      if (isMine || wasNearBottom) {
        this.pendingScrollToBottom = true;
        this.newMessageBannerVisible = false;
        this.newMessageCount = 0;
        this.markLastMessageRead();
      } else {
        this.newMessageBannerVisible = true;
        this.newMessageCount++;
      }
    });

    socket.on('channel:messageEdited', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const msg = this.messages.find((m) => m.id === data.messageId);
      if (msg) {
        msg.text = data.text;
        msg.editedAt = data.editedAt;
      }
    });

    // Thêm listener cho trạng thái đã xem
    socket.on('channel:readStatus', (data: any) => {
      if (data.channelId === this.currentChannelId) {
        this.readStatus = data.readStatus;
      }
    });

    socket.on('channel:messageDeleted', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const msg = this.messages.find((m) => m.id === data.messageId);
      // Xóa tạm thời: giữ nguyên nội dung để nút "Hoàn tác" khôi phục được
      if (msg) msg.deleted = true;
    });

    socket.on('channel:messageRestored', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const msg = this.messages.find((m) => m.id === data.messageId);
      if (msg) msg.deleted = false;
    });

    socket.on('channel:messageRemoved', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const idx = this.messages.findIndex((m) => m.id === data.messageId);
      if (idx >= 0) this.messages.splice(idx, 1);
    });

    socket.on('channel:messageReaction', (data: any) => {
      if (data.channelId !== this.currentChannelId) return;
      const msg = this.messages.find((m) => m.id === data.messageId);
      if (msg) msg.reactions = data.reactions;
    });

    socket.on('channel:members', (data: any) => {
      if (data.channelId === this.currentChannelId) {
        this.members = data.members || [];
      }
    });

    socket.on('channel:typing', (data: any) => {
      if (data.channelId === this.currentChannelId) {
        this.typingNames = (data.typingNames || []).filter((n: string) => n !== this.myName);
      }
    });

    socket.on('error', (msg: string) => {
      console.error('Lỗi từ server:', msg);
      alert(msg);
    });

    socket.on('channel:destroyed', () => {
      alert('Phòng chat này vừa bị Admin xóa!');
      this.leaveCurrentChannel();
    });
  }

  ngAfterViewChecked() {
    if (this.pendingScrollToBottom) {
      this.pendingScrollToBottom = false;
      this.scrollToBottom();
    }
  }

  // ===== ĐĂNG NHẬP =====
  submitName() {
    const trimmed = this.nameInput.trim();
    if (!trimmed) return;
    this.myName = trimmed;
    // Kèm mật khẩu quản trị nếu có — nhập đúng server sẽ gắn quyền admin cho phiên này
    this.socketService.setName(trimmed, this.adminPasswordInput.trim() || undefined);
    this.nameEntered = true;
    this.adminPasswordInput = '';
  }

  // ===== HÀM CẬP NHẬT ĐÃ XEM =====
  markLastMessageRead() {
    // KHI CHẠY TRÊN TRÌNH DUYỆT: Kiểm tra xem tab có đang mở VÀ cửa sổ có đang được focus không
    if (isPlatformBrowser(this.platformId)) {
      const isVisible = document.visibilityState === 'visible';
      const hasFocus = document.hasFocus();
      
      // Nếu đang ở tab khác, hoặc đang dùng phần mềm khác (Word, Excel...) -> KHÔNG ĐÁNH DẤU ĐÃ XEM
      if (!isVisible || !hasFocus) {
        return; 
      }
    }

    setTimeout(() => {
      if (this.currentChannelId && this.messages.length > 0) {
        // Lấy tin nhắn cuối cùng
        const lastMsg = this.messages[this.messages.length - 1];
        this.socketService.markRead(this.currentChannelId, lastMsg.id);
      }
    }, 100);
  }

  getReadersForMessage(messageId: number): any[] {
    return Object.keys(this.readStatus)
      .filter(userId => this.readStatus[userId] === messageId && userId !== this.socketService.myId)
      .map(userId => this.members.find(m => m.userId === userId))
      .filter(m => m !== undefined);
  }

  // ===== FAB (thay cho sidebar: danh sách phòng + tiện ích) =====
  toggleFab() {
    this.fabOpen = !this.fabOpen;
  }

  closeFab() {
    this.fabOpen = false;
  }

  leaveCurrentChannel() {
    if (!this.currentChannelId) return;
    this.socketService.leaveChannel();
    this.currentChannelId = '';
    this.currentChannelName = '';
    this.messages = [];
    this.members = [];
    this.typingNames = [];
    this.newMessageBannerVisible = false;
    this.newMessageCount = 0;
    this.fabOpen = false;
  }

  deleteChannel(event: Event, channelId: string, channelName: string) {
    event.stopPropagation(); // Ngăn không cho click này kích hoạt việc "Vào phòng"
    
    // Hiển thị hộp thoại nhập mật khẩu mặc định của trình duyệt
    const adminPass = prompt(`Bạn đang muốn XÓA phòng "${channelName}".\nVui lòng nhập mật khẩu Admin:`);
    
    if (adminPass) {
      this.socketService.adminDeleteChannel(channelId, adminPass);
    }
  }

  // ===== TẠO PHÒNG =====
  openCreateChannelModal() {
    this.showCreateChannelModal = true;
    this.newChannelName = '';
    this.newChannelPassword = '';
  }

  closeCreateChannelModal() {
    this.showCreateChannelModal = false;
  }

  submitCreateChannel() {
    const trimmedName = this.newChannelName.trim();
    const trimmedPassword = this.newChannelPassword.trim();
    if (!trimmedName || !trimmedPassword) return;
    this.socketService.createChannel(trimmedName, trimmedPassword);
  }

  // ===== CHỌN PHÒNG (luôn phải qua bước nhập mật khẩu) =====
  onChannelClick(ch: ChannelSummary) {
    if (ch.id === this.currentChannelId) {
      this.fabOpen = false;
      return;
    }
    this.openPasswordPrompt(ch.id, ch.name);
  }

  openPasswordPrompt(channelId: string, channelName: string) {
    this.passwordPromptChannelId = channelId;
    this.passwordPromptChannelName = channelName;
    this.passwordPromptInput = '';
    this.passwordPromptError = '';
  }

  closePasswordPrompt() {
    this.passwordPromptChannelId = null;
    this.passwordPromptError = '';
  }

  submitPasswordPrompt() {
    if (!this.passwordPromptChannelId || !this.passwordPromptInput.trim()) return;
    this.passwordPromptError = '';
    this.isLoadingChannel = true;
    this.messages = [];
    this.members = [];
    this.typingNames = [];
    this.cancelReply();
    this.cancelEdit();
    this.socketService.joinChannel(this.passwordPromptChannelId, this.passwordPromptInput);
  }

  get filteredChannels(): ChannelSummary[] {
    const q = this.channelSearch.trim().toLowerCase();
    if (!q) return this.channels;
    return this.channels.filter((c) => c.name.toLowerCase().includes(q));
  }

  // ===== GỬI TIN NHẮN =====
  sendMessage() {
    const el = this.messageInputEl?.nativeElement;
    const html = el?.innerHTML.trim() || '';
    const plain = el?.textContent?.trim() || '';
    if ((!plain && !this.pendingImage) || !this.currentChannelId) return;

    this.socketService.sendMessage(this.currentChannelId, html, this.pendingImage, this.replyingTo);

    if (el) el.innerHTML = '';
    this.hasComposerContent = false;
    this.pendingImage = null;
    this.replyingTo = null;
    this.stopTyping();
  }

  onComposerInput() {
    const el = this.messageInputEl?.nativeElement;
    this.hasComposerContent = !!(el && el.textContent && el.textContent.trim().length > 0);
  }

  onMessageKeydown(event: KeyboardEvent) {
    // Ctrl+B: chữ đậm
    if (event.ctrlKey && !event.altKey && (event.key === 'b' || event.key === 'B')) {
      event.preventDefault();
      document.execCommand('bold');
      return;
    }
    // Ctrl+I chữ nghiêng
    if (event.ctrlKey && !event.altKey && (event.key === 'i' || event.key === 'I')) {
      event.preventDefault();
      document.execCommand('italic');
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
      return;
    }
    this.onTyping();
  }

  private onTyping() {
    if (!this.currentChannelId) return;
    if (!this.isCurrentlyTyping) {
      this.isCurrentlyTyping = true;
      this.socketService.setTyping(this.currentChannelId, true);
    }
    clearTimeout(this.typingStopTimeout);
    this.typingStopTimeout = setTimeout(() => this.stopTyping(), 2000);
  }

  private stopTyping() {
    if (this.isCurrentlyTyping && this.currentChannelId) {
      this.isCurrentlyTyping = false;
      this.socketService.setTyping(this.currentChannelId, false);
    }
    clearTimeout(this.typingStopTimeout);
  }

  // ===== PASTE TỪ CLIPBOARD (ô soạn tin nhắn) =====
  onComposerPaste(event: ClipboardEvent) {
    // Ảnh -> giữ nguyên như cũ
    const dataUrl = this.extractImageFromPaste(event);
    if (dataUrl !== undefined) {
      dataUrl.then((url) => {
        if (url) this.pendingImage = url;
      });
      return;
    }

    // Chữ: TỰ lấy nội dung clipboard và chèn (không để trình duyệt tự dán)
    // để đảm bảo dán ĐỦ toàn bộ nội dung, giữ định dạng (đậm, nghiêng, gạch đầu dòng,
    // xuống dòng, thụt lề) và bỏ màu/mã nguồn lạ từ trang bản gốc
    event.preventDefault();
    const el = this.messageInputEl?.nativeElement;
    if (!el || !event.clipboardData) return;
    el.focus();

    const html = event.clipboardData.getData('text/html');
    const plain = event.clipboardData.getData('text/plain') || '';
    let insertHtml = html ? this.sanitizePastedHtml(html) : '';
    // Nếu HTML sau khi dọn không còn chữ gì (hoặc clipboard chỉ có text thuần) -> chuyển text thuần
    if (!this.stripHtml(insertHtml) && plain) {
      insertHtml = this.plainTextToHtml(plain);
    }
    if (insertHtml) document.execCommand('insertHTML', false, insertHtml);
    this.onComposerInput();
  }

  removePendingImage() {
    this.pendingImage = null;
  }

  // Dọn HTML dán vào: chỉ giữ thẻ cấu trúc (đậm/nghiêng/danh sách/xuống dòng...),
  // bỏ script/ảnh/iframe/mọi attribute (màu, class, data-...) để chữ luôn đọc được trên nền tối
  private sanitizePastedHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const BLOCKED = new Set([
      'SCRIPT', 'STYLE', 'IMG', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED',
      'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
    ]);
    const ALLOWED = new Set([
      'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS', 'CODE', 'PRE', 'BR',
      'P', 'DIV', 'UL', 'OL', 'LI', 'SPAN', 'BLOCKQUOTE', 'SUB', 'SUP', 'HR',
    ]);
    const unwrap = (node: Element) => {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    };
    const walk = (node: Element) => {
      for (const child of Array.from(node.children)) {
        walk(child);
        if (BLOCKED.has(child.tagName)) {
          child.remove();
          continue;
        }
        if (child.tagName === 'A') {
          unwrap(child); // giữ chữ, bỏ link
          continue;
        }
        if (!ALLOWED.has(child.tagName)) {
          unwrap(child); // thẻ lạ: giữ chữ bên trong, bỏ thẻ
          continue;
        }
        for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  // Text thuần -> HTML an toàn, giữ nguyên xuống dòng
  private plainTextToHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r\n?/g, '\n')
      .replace(/\n/g, '<br>');
  }

  // ===== PASTE VÀO Ô SỬA TIN NHẮN (chỉ chữ, không ảnh) =====
  onEditBoxPaste(event: ClipboardEvent) {
    event.preventDefault();
    const el = this.editInputEl?.nativeElement;
    if (!el || !event.clipboardData) return;
    el.focus();
    const html = event.clipboardData.getData('text/html');
    const plain = event.clipboardData.getData('text/plain') || '';
    let insertHtml = html ? this.sanitizePastedHtml(html) : '';
    if (!this.stripHtml(insertHtml) && plain) {
      insertHtml = this.plainTextToHtml(plain);
    }
    if (insertHtml) document.execCommand('insertHTML', false, insertHtml);
  }

  // ===== PHÍM TẮT TRONG Ô SỬA TIN NHẮN =====
  onEditBoxKeydown(event: KeyboardEvent, msg: ChatMessage) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
      return;
    }
    // Ctrl+Enter: lưu; Enter thường: xuống dòng
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.submitEdit(msg);
      return;
    }
    if (event.ctrlKey && !event.altKey && (event.key === 'b' || event.key === 'B')) {
      event.preventDefault();
      document.execCommand('bold');
      return;
    }
    if (event.ctrlKey && !event.altKey && (event.key === 'i' || event.key === 'I')) {
      event.preventDefault();
      document.execCommand('italic');
      return;
    }
  }

  // ===== PASTE ẢNH VÀO VÙNG SIDEBAR / HEADER (thay giao diện thật bằng ảnh) =====
  onSidebarPaste(event: ClipboardEvent) {
    const dataUrl = this.extractImageFromPaste(event);
    if (dataUrl === undefined) return;
    // dataUrl.then((url) => {
    //   if (url) this.sidebarImage = url;
    // });
  }

  onHeaderPaste(event: ClipboardEvent) {
    const dataUrl = this.extractImageFromPaste(event);
    // if (dataUrl === undefined) return;
    // dataUrl.then((url) => {
    //   if (url) this.headerImage = url;
    // });
  }

  clearSidebarImage(event: MouseEvent) {
    event.stopPropagation();
    // this.sidebarImage = null;
  }

  clearHeaderImage(event: MouseEvent) {
    event.stopPropagation();
    // this.headerImage = null;
  }

  // Helper dùng chung: trích ảnh từ sự kiện paste, trả về Promise<string|null>,
  // hoặc undefined nếu clipboard không chứa ảnh (để component gọi biết bỏ qua)
  private extractImageFromPaste(event: ClipboardEvent): Promise<string | null> | undefined {
    const items = event.clipboardData?.items;
    if (!items) return undefined;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        if (file.size > 8 * 1024 * 1024) {
          alert('Ảnh quá lớn (giới hạn khoảng 8MB)');
          return Promise.resolve(null);
        }

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
      }
    }
    return undefined;
  }

  // ===== REPLY (QUOTE) =====
  startReply(msg: ChatMessage) {
    if (msg.deleted) return;
    this.replyingTo = {
      id: msg.id,
      userName: msg.userName,
      text: this.stripHtml(msg.text) || (msg.imageData ? '📷 Hình ảnh' : ''),
      hasImage: !!msg.imageData,
    };
    this.messageInputEl?.nativeElement.focus();
  }

  cancelReply() {
    this.replyingTo = null;
  }

  scrollToMessage(messageId: number) {
    const el = document.getElementById('msg-' + messageId);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 1200);
    }
  }

  // Bỏ thẻ HTML, chỉ lấy phần chữ thuần — dùng cho trích dẫn reply và khi sửa tin nhắn
  private stripHtml(html: string): string {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').trim();
  }

  // ===== SỬA TIN NHẮN (chủ tin nhắn hoặc admin) =====
  startEdit(msg: ChatMessage) {
    if (msg.deleted) return;
    if (!this.isMine(msg) && !this.isAdmin) return;
    this.editingMessageId = msg.id;
    this.editingHtml = msg.text || '';
  }

  cancelEdit() {
    this.editingMessageId = null;
    this.editingHtml = '';
  }

  submitEdit(msg: ChatMessage) {
    const el = this.editInputEl?.nativeElement;
    const html = el?.innerHTML || '';
    const plain = el?.textContent?.trim() || '';
    if (!plain && !msg.imageData) return; // không cho sửa thành rỗng nếu không có ảnh
    this.socketService.editMessage(this.currentChannelId, msg.id, html);
    this.cancelEdit();
  }

  // ===== XOÁ / HOÀN TÁC TIN NHẮN =====
  // Xóa tạm thời (vẫn hiện "Tin nhắn đã bị xoá", có thể hoàn tác): chủ tin nhắn hoặc admin
  deleteMessage(msg: ChatMessage) {
    if (msg.deleted) return;
    if (!this.isMine(msg) && !this.isAdmin) return;
    if (!confirm('Xóa tin nhắn này?\n(Xóa tạm thời — vẫn có thể hoàn tác)')) return;
    this.socketService.deleteMessage(this.currentChannelId, msg.id, false);
  }

  // Xóa hẳn: tin nhắn biến mất khỏi lịch sử, không thể hoàn tác — chỉ admin
  hardDeleteMessage(msg: ChatMessage) {
    if (msg.deleted || !this.isAdmin) return;
    if (!confirm('XÓA HẲN tin nhắn này?\nTin nhắn sẽ biến mất khỏi lịch sử và KHÔNG thể hoàn tác!')) return;
    this.socketService.deleteMessage(this.currentChannelId, msg.id, true);
  }

  // Hoàn tác xóa: chủ tin nhắn (tin của mình) hoặc admin (tin của bất kỳ ai)
  restoreMessage(msg: ChatMessage) {
    if (!msg.deleted) return;
    if (!this.isMine(msg) && !this.isAdmin) return;
    this.socketService.restoreMessage(this.currentChannelId, msg.id);
  }

  isAdminSender(msg: ChatMessage): boolean {
    return !!msg.isAdmin;
  }

  // ===== REACTION =====
  toggleReactionPicker(messageId: number) {
    this.reactionPickerFor = this.reactionPickerFor === messageId ? null : messageId;
  }

  pickReaction(msg: ChatMessage, emoji: string) {
    this.socketService.reactMessage(this.currentChannelId, msg.id, emoji);
    this.reactionPickerFor = null;
  }

  reactionEntries(msg: ChatMessage): { emoji: string; count: number; mine: boolean; userNames: string }[] {
    if (!msg.reactions) return [];
    
    return Object.entries(msg.reactions).map(([emoji, userIds]) => {
      // Chuyển đổi danh sách UserID thành Tên hiển thị
      const names = userIds.map(id => {
        // Nếu ID đó là của chính mình
        // if (id === this.socketService.myId) return 'Bạn';
        
        // Nếu ID của người khác, tìm tên họ trong danh sách thành viên phòng
        const member = this.members.find(m => m.userId === id);
        return member ? member.name : 'Người dùng ẩn'; // (Trường hợp họ đã out phòng)
      });

      return {
        emoji,
        count: userIds.length,
        mine: userIds.includes(this.socketService.myId),
        userNames: names.join(', ') // Ghép các tên lại bằng dấu phẩy, VD: "Bạn, Tuấn, Hùng"
      };
    });
  }

  isMine(msg: ChatMessage): boolean {
    return msg.userId === this.socketService.myId;
  }

  // ===== PANEL THÀNH VIÊN =====
  toggleMembersPanel() {
    this.showMembersPanel = !this.showMembersPanel;
  }

  // ===== NHÓM TIN NHẮN THEO NGƯỜI GỬI =====
  isSameSenderAsPrevious(index: number): boolean {
    if (index === 0) return false;
    const prev = this.messages[index - 1];
    const cur = this.messages[index];
    if (prev.userId !== cur.userId) return false;
    if (!this.isSameCalendarDay(prev.time, cur.time)) return false;
    return cur.time - prev.time < 5 * 60 * 1000;
  }

  // ===== DẤU NGÀY =====
  shouldShowDateSeparator(index: number): boolean {
    if (index === 0) return true;
    const prev = this.messages[index - 1];
    const cur = this.messages[index];
    return !this.isSameCalendarDay(prev.time, cur.time);
  }

  private isSameCalendarDay(a: number, b: number): boolean {
    const d1 = new Date(a);
    const d2 = new Date(b);
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  }

  getDateSeparatorLabel(ms: number): string {
    const d = new Date(ms);
    const now = new Date();

    if (this.isSameCalendarDay(ms, now.getTime())) return 'Hôm nay';

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (this.isSameCalendarDay(ms, yesterday.getTime())) return 'Hôm qua';

    const diffDays = Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
    const weekdays = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

    if (diffDays >= 0 && diffDays < 7) {
      return weekdays[d.getDay()];
    }

    const sameYear = d.getFullYear() === now.getFullYear();
    const datePart = d.getDate() + ' tháng ' + (d.getMonth() + 1) + (sameYear ? '' : ', ' + d.getFullYear());
    return weekdays[d.getDay()] + ', ' + datePart;
  }

  // ===== CUỘN THÔNG MINH =====
  private isNearBottom(): boolean {
    const el = this.messagesEl?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  onMessagesScroll() {
    if (this.newMessageBannerVisible && this.isNearBottom()) {
      this.newMessageBannerVisible = false;
      this.newMessageCount = 0;
    }
    if (this.isNearBottom()) {
      this.markLastMessageRead();
    }
  }

  scrollToBottomAndDismissBanner() {
    this.newMessageBannerVisible = false;
    this.newMessageCount = 0;
    this.pendingScrollToBottom = true;
  }

  // ===== XEM ẢNH PHÓNG TO =====
  openImageViewer(src: string | null | undefined) {
    if (!src) return;
    this.viewerImage = src;
    this.viewerScale = 1;
    this.viewerOffsetX = 0;
    this.viewerOffsetY = 0;
  }

  closeImageViewer() {
    this.viewerImage = null;
  }

  zoomIn() {
    this.viewerScale = Math.min(4, this.viewerScale + 0.25);
  }

  zoomOut() {
    this.viewerScale = Math.max(0.5, this.viewerScale - 0.25);
  }

  resetZoom() {
    this.viewerScale = 1;
    this.viewerOffsetX = 0;
    this.viewerOffsetY = 0;
  }

  onViewerWheel(event: WheelEvent) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.15 : 0.15;
    this.viewerScale = Math.min(4, Math.max(0.5, this.viewerScale + delta));
  }

  onViewerMouseDown(event: MouseEvent) {
    event.preventDefault();
    this.isDraggingViewer = true;
    this.dragStartX = event.clientX - this.viewerOffsetX;
    this.dragStartY = event.clientY - this.viewerOffsetY;
  }

  @HostListener('document:mousemove', ['$event'])
  onDocMouseMove(event: MouseEvent) {
    if (!this.isDraggingViewer) return;
    this.viewerOffsetX = event.clientX - this.dragStartX;
    this.viewerOffsetY = event.clientY - this.dragStartY;
  }

  @HostListener('document:mouseup')
  onDocMouseUp() {
    this.isDraggingViewer = false;
  }

  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (this.viewerImage) this.closeImageViewer();
      else if (this.editingMessageId !== null) this.cancelEdit();
      else if (this.passwordPromptChannelId) this.closePasswordPrompt();
      else if (this.replyingTo) this.cancelReply();
      else if (this.fabOpen) this.closeFab();
    }
  }

  // ===== HELPERS =====
  getInitials(name: string): string {
    // Chỉ lấy CHỮ CÁI ĐẦU TIÊN (không lấy 2 chữ như trước)
    return name.trim().charAt(0).toUpperCase();
  }

  private avatarPalette = [
    '#9BA8D9', // Xanh lơ nhạt
    '#ECA4B2', // Đỏ hồng nhạt
    '#8BC4F0', // Xanh da trời nhạt
    '#9AD69A', // Xanh lá nhạt
    '#D998CE', // Tím nhạt
    '#E8AD8B', // Cam nhạt
    '#76D3C1', // Xanh mint nhạt
    '#B9A1E0'  // Tím pastel
  ];

  getAvatarColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const idx = Math.abs(hash) % this.avatarPalette.length;
    return this.avatarPalette[idx];
  }

  formatTime(ms: number): string {
    const d = new Date(ms);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  formatPreviewTime(ms: number | undefined): string {
    if (!ms) return '';
    return this.formatTime(ms);
  }

  private scrollToBottom() {
    setTimeout(() => {
      const el = this.messagesEl?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  @HostListener('window:focus')
  onWindowFocus() {
    // Chỉ đánh dấu đã xem nếu họ đang cuộn ở dưới cùng
    if (this.isNearBottom()) {
      this.markLastMessageRead();
    }
  }

  // Bắt sự kiện khi người dùng chuyển từ Tab khác (Youtube...) về lại Tab Chat
  @HostListener('document:visibilitychange')
  onVisibilityChange() {
    if (document.visibilityState === 'visible' && this.isNearBottom()) {
      this.markLastMessageRead();
    }
  }

  ngOnDestroy() {
    clearTimeout(this.typingStopTimeout);
  }
}
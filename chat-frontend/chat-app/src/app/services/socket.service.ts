import { Injectable, OnDestroy, PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { io, Socket } from 'socket.io-client';

// Tự động dùng đúng địa chỉ máy chủ dựa trên cách trang được truy cập
// (localhost khi chạy trên chính máy bạn, hoặc IP LAN khi người khác truy cập từ xa)
const SERVER_URL_FACTORY = () => `http://${window.location.hostname}:3021`;

@Injectable({ providedIn: 'root' })
export class SocketService implements OnDestroy {
  socket: Socket | null = null;
  myId = '';

  private platformId = inject(PLATFORM_ID);

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;

    this.socket = io(SERVER_URL_FACTORY());

    this.socket.on('connect', () => {
      this.myId = this.socket?.id || '';
      console.log('Connected to chat server:', this.myId);
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from chat server');
    });
  }

  setName(name: string, adminPassword?: string) {
    this.socket?.emit('setName', { name, adminPassword: adminPassword || null });
  }

  createChannel(name: string, password: string) {
    this.socket?.emit('channel:create', { name, password });
  }

  joinChannel(channelId: string, password: string) {
    this.socket?.emit('channel:join', { channelId, password });
  }

  leaveChannel() {
    this.socket?.emit('channel:leave');
  }

  sendMessage(channelId: string, text: string, imageData?: string | null, replyTo?: any) {
    this.socket?.emit('channel:message', { channelId, text, imageData: imageData || null, replyTo: replyTo || null });
  }

  editMessage(channelId: string, messageId: number, text: string) {
    this.socket?.emit('channel:editMessage', { channelId, messageId, text });
  }

  // hard = false: xóa tạm thời (vẫn hoàn tác được) — hard = true: xóa hẳn (chỉ admin)
  deleteMessage(channelId: string, messageId: number, hard = false) {
    this.socket?.emit('channel:deleteMessage', { channelId, messageId, hard });
  }

  restoreMessage(channelId: string, messageId: number) {
    this.socket?.emit('channel:restoreMessage', { channelId, messageId });
  }

  reactMessage(channelId: string, messageId: number, emoji: string) {
    this.socket?.emit('channel:reactMessage', { channelId, messageId, emoji });
  }

  setTyping(channelId: string, isTyping: boolean) {
    this.socket?.emit('channel:typing', { channelId, isTyping });
  }

  markRead(channelId: string, messageId: number) {
    this.socket?.emit('channel:markRead', { channelId, messageId });
  }

  ngOnDestroy() {
    this.socket?.disconnect();
  }

  adminDeleteChannel(channelId: string, adminPassword: string) {
    this.socket?.emit('channel:adminDelete', { channelId, adminPassword });
  }
}

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  MessageSquarePlus,
  Search,
  SendHorizontal,
  ShieldCheck,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { apiFetch, streamChat } from '../lib/api';
import type { ChatMessageInfo, ConversationInfo } from '../types/neo';

type ChatMode = 'streaming' | 'reasoning' | 'local';
type LanguageChoice = 'auto' | 'en' | 'fa' | 'ar' | 'nl';

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  streaming?: boolean;
  metadata?: Record<string, unknown>;
}

const STARTER_PROMPTS: Array<{ title: string; subtitle: string; prompt: string }> = [
  {
    title: 'معرفی و قابلیت‌های Neo',
    subtitle: 'پرسش فارسی · معماری و ابزارها',
    prompt: 'سلام! خودت را معرفی کن و بگو چه قابلیت‌هایی داری؟',
  },
  {
    title: 'معماری حافظه و امنیت',
    subtitle: '۷ لایه حافظه · ایزوله‌سازی',
    prompt: 'معماری حافظه ۷ لایه و سیستم امنیت Neo چطور کار می‌کند؟',
  },
  {
    title: 'Deterministic Math & Logic',
    subtitle: 'CPU Symbolic Grounding',
    prompt: 'Calculate (1450 * 12) - 2400 and verify the result',
  },
  {
    title: 'System & Runtime Capabilities',
    subtitle: 'Model routing & open-weight engines',
    prompt: 'Who are you and how does Neo route across local open-weight models?',
  },
];

function isRtlText(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function formatShortTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderInlineFormatting(text: string): Array<ReactNode> {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          dir="ltr"
          className="px-1.5 py-0.5 rounded bg-[#0B0F17] border border-slate-800 font-mono text-[11px] text-blue-300"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
      return (
        <em key={idx} className="italic text-slate-300">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}

function SafeMessageRenderer({ content }: { content: string }) {
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null);
  const segments = useMemo(() => {
    const out: Array<{ type: 'text' | 'code'; lang?: string; body: string }> = [];
    const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match.index > lastIdx) {
        out.push({ type: 'text', body: content.slice(lastIdx, match.index) });
      }
      out.push({ type: 'code', lang: match[1] || 'text', body: match[2].replace(/\n$/, '') });
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < content.length) {
      out.push({ type: 'text', body: content.slice(lastIdx) });
    }
    return out;
  }, [content]);

  const copyCode = async (idx: number, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedBlock(idx);
      setTimeout(() => setCopiedBlock((cur) => (cur === idx ? null : cur)), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed text-slate-200 break-words">
      {segments.map((seg, segIdx) => {
        if (seg.type === 'code') {
          return (
            <div key={segIdx} dir="ltr" className="rounded border border-slate-800 bg-[#0B0F17] overflow-hidden text-left">
              <div className="px-3 py-1.5 border-b border-slate-800 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>{seg.lang}</span>
                <button
                  type="button"
                  onClick={() => void copyCode(segIdx, seg.body)}
                  className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 whitespace-nowrap"
                >
                  {copiedBlock === segIdx ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedBlock === segIdx ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="p-3 overflow-x-auto text-xs font-mono text-slate-200">{seg.body}</pre>
            </div>
          );
        }

        const lines = seg.body.split('\n');
        return (
          <div key={segIdx} className="space-y-1.5">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return <div key={lineIdx} className="h-1" />;

              const rtlLine = isRtlText(trimmed);
              if (/^#{1,3}\s+/.test(trimmed)) {
                const headingText = trimmed.replace(/^#{1,3}\s+/, '');
                return (
                  <h4 key={lineIdx} dir={rtlLine ? 'rtl' : 'ltr'} className="font-display text-sm font-semibold text-slate-100 pt-1">
                    {renderInlineFormatting(headingText)}
                  </h4>
                );
              }
              if (/^[-*•]\s+/.test(trimmed)) {
                const itemText = trimmed.replace(/^[-*•]\s+/, '');
                return (
                  <div
                    key={lineIdx}
                    dir={rtlLine ? 'rtl' : 'ltr'}
                    className="flex items-start gap-2"
                  >
                    <span className="text-blue-400 select-none mt-0.5">•</span>
                    <div className="flex-1 min-w-0">{renderInlineFormatting(itemText)}</div>
                  </div>
                );
              }
              const orderedMatch = trimmed.match(/^(\d+)[.)]\s+([\s\S]+)$/);
              if (orderedMatch) {
                return (
                  <div
                    key={lineIdx}
                    dir={rtlLine ? 'rtl' : 'ltr'}
                    className="flex items-start gap-2"
                  >
                    <span className="font-mono text-xs text-slate-400 tabular-nums mt-0.5 shrink-0">{orderedMatch[1]}.</span>
                    <div className="flex-1 min-w-0">{renderInlineFormatting(orderedMatch[2])}</div>
                  </div>
                );
              }

              return (
                <p key={lineIdx} dir={rtlLine ? 'rtl' : 'ltr'}>
                  {renderInlineFormatting(line)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function ChatView() {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ChatMode>('streaming');
  const [language, setLanguage] = useState<LanguageChoice>('auto');
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedDetailsId, setExpandedDetailsId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await apiFetch<{ conversations: ConversationInfo[] }>('/api/v1/conversations');
      setConversations(res.conversations || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversation history');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending]);

  const openConversation = async (convId: string) => {
    if (sending) return;
    setError(null);
    setLoadingMessages(true);
    setActiveConvId(convId);
    setMobileHistoryOpen(false);
    try {
      const res = await apiFetch<{ conversation: ConversationInfo; messages: ChatMessageInfo[] }>(
        `/api/v1/conversations/${encodeURIComponent(convId)}/messages`
      );
      setMessages(
        (res.messages || []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          created_at: m.created_at,
          metadata: m.metadata,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open conversation');
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleNewChat = () => {
    if (sending) {
      abortRef.current?.abort();
    }
    setActiveConvId(undefined);
    setMessages([]);
    setError(null);
    setMobileHistoryOpen(false);
    composerRef.current?.focus();
  };

  const handleDeleteConversation = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    try {
      await apiFetch(`/api/v1/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' });
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (activeConvId === convId) {
        setActiveConvId(undefined);
        setMessages([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete conversation');
    }
  };

  const handleStopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  };

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || sending) return;

    setError(null);
    if (!overrideText) setInput('');
    setSending(true);

    const nowIso = new Date().toISOString();
    const userMsgId = `local-user-${Date.now()}`;
    const assistantMsgId = `local-assistant-${Date.now() + 1}`;
    const langParam = language === 'auto' ? undefined : language;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text, created_at: nowIso },
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        created_at: nowIso,
        streaming: true,
      },
    ]);

    try {
      if (mode === 'reasoning') {
        const res = await apiFetch<{
          conversationId: string;
          reply: string;
          language: string;
          runtime: string;
          model: string;
          confidence: number;
          verification?: { passed?: boolean; overallScore?: number; issues?: string[] };
          latencyMs: number;
        }>('/api/v1/chat', {
          method: 'POST',
          body: JSON.stringify({
            message: text,
            conversationId: activeConvId,
            ...(langParam ? { language: langParam } : {}),
          }),
        });

        setActiveConvId(res.conversationId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: res.reply,
                  streaming: false,
                  metadata: {
                    runtime: res.runtime,
                    model: res.model,
                    language: res.language,
                    confidence: res.confidence,
                    latencyMs: res.latencyMs,
                    verification: res.verification,
                  },
                }
              : m
          )
        );
      } else {
        const controller = new AbortController();
        abortRef.current = controller;
        let streamMeta: Record<string, unknown> = {};
        let resolvedConvId = activeConvId;

        await streamChat(
          {
            message: text,
            conversationId: activeConvId,
            ...(langParam ? { language: langParam } : {}),
            mode: mode === 'local' ? 'sovereign-local' : 'neural',
          },
          {
            signal: controller.signal,
            onMeta: (meta) => {
              if (meta.conversationId) {
                resolvedConvId = meta.conversationId;
                setActiveConvId(meta.conversationId);
              }
              streamMeta = {
                ...streamMeta,
                language: meta.language,
                ragMatches: meta.ragMatches,
                engine: meta.engine,
              };
            },
            onDelta: (chunk) => {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsgId ? { ...m, content: m.content + chunk } : m))
              );
            },
            onDone: (doneMeta) => {
              const merged = { ...streamMeta, ...doneMeta };
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsgId ? { ...m, streaming: false, metadata: merged } : m))
              );
              if (typeof doneMeta.conversationId === 'string') {
                resolvedConvId = doneMeta.conversationId;
                setActiveConvId(doneMeta.conversationId);
              }
            },
            onError: (msg) => {
              setError(msg);
            },
          }
        );

        if (resolvedConvId) {
          setActiveConvId(resolvedConvId);
        }
      }

      await loadConversations();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: m.content || 'Generation stopped.', streaming: false }
              : m
          )
        );
      } else {
        const errMsg = err instanceof Error ? err.message : 'Failed to communicate with Neo';
        setError(errMsg);
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId || m.content.trim().length > 0));
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleCopyMessage = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConvId) || null,
    [conversations, activeConvId]
  );

  const historyPanel = (
    <div className="h-full flex flex-col bg-[#0D131F] border-r border-slate-800">
      <div className="p-3 border-b border-slate-800 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleNewChat}
            className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white whitespace-nowrap"
          >
            <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
            <span>New Conversation</span>
          </button>
          <button
            type="button"
            onClick={() => setMobileHistoryOpen(false)}
            className="lg:hidden p-2 rounded border border-slate-800 text-slate-400 hover:text-slate-200"
            aria-label="Close thread history"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter threads..."
            aria-label="Filter conversations"
            className="w-full pl-8 pr-3 py-1.5 bg-[#0B0F17] border border-slate-800 rounded text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
        {loadingList && conversations.length === 0 ? (
          <div className="p-4 space-y-2">
            {[0, 1, 2].map((idx) => (
              <div key={idx} className="h-11 rounded bg-[#111827] border border-slate-800/70 animate-pulse" />
            ))}
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="p-4 text-xs text-slate-500 text-center">
            {conversations.length === 0 ? 'No saved conversations yet.' : 'No matching threads.'}
          </div>
        ) : (
          filteredConversations.map((conv) => {
            const active = conv.id === activeConvId;
            return (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => void openConversation(conv.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void openConversation(conv.id);
                  }
                }}
                className={`group px-3 py-2.5 cursor-pointer flex items-start justify-between gap-2 transition-colors ${
                  active ? 'bg-blue-600/15 text-slate-100' : 'hover:bg-slate-800/50 text-slate-300'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div
                    dir={isRtlText(conv.title) ? 'rtl' : 'ltr'}
                    className="text-xs font-medium truncate"
                  >
                    {conv.title}
                  </div>
                  <div className="mt-0.5 text-[11px] font-mono text-slate-500 tabular-nums">
                    {conv.language} · {formatShortDate(conv.updated_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => void handleDeleteConversation(e, conv.id)}
                  title="Delete conversation"
                  aria-label="Delete conversation"
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition-opacity shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className="relative h-[calc(100vh-8.5rem)] min-h-[540px] bg-[#111827] border border-slate-800 rounded overflow-hidden flex">
      {/* Desktop Thread Sidebar */}
      <aside className="hidden lg:block w-72 shrink-0 h-full">{historyPanel}</aside>

      {/* Mobile Thread Drawer */}
      {mobileHistoryOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-72 max-w-[85vw] h-full shadow-2xl">{historyPanel}</div>
          <div className="flex-1 bg-black/60" onClick={() => setMobileHistoryOpen(false)} aria-hidden="true" />
        </div>
      )}

      {/* Main Conversational Workspace */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0B0F17]">
        {/* Header Bar */}
        <div className="px-4 py-3 bg-[#0D131F] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileHistoryOpen(true)}
              className="lg:hidden p-1.5 rounded border border-slate-800 text-slate-300 hover:bg-slate-800 shrink-0"
              aria-label="Open conversation history"
            >
              <History className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div
                dir={activeConversation && isRtlText(activeConversation.title) ? 'rtl' : 'ltr'}
                className="text-xs sm:text-sm font-display font-semibold text-slate-100 truncate"
              >
                {activeConversation ? activeConversation.title : 'New Conversation with Neo'}
              </div>
              <div className="text-[11px] font-mono text-slate-400">
                {activeConvId ? `Session ${activeConvId.slice(0, 8)}` : 'Ready'} · 7-Layer RAG + Sovereign Inference
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex rounded border border-slate-800 bg-[#0B0F17] p-0.5">
              {(
                [
                  ['streaming', 'Streaming'],
                  ['reasoning', 'Deep Reasoning'],
                  ['local', 'Local Memory'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMode(id)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${
                    mode === id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as LanguageChoice)}
              aria-label="Response language"
              className="px-2.5 py-1.5 bg-[#0B0F17] border border-slate-800 rounded text-[11px] font-mono text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="auto">Lang: Auto</option>
              <option value="fa">فارسی (fa)</option>
              <option value="en">English (en)</option>
              <option value="ar">العربية (ar)</option>
              <option value="nl">Nederlands (nl)</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 px-3 py-2 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-rose-300 hover:text-rose-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Message Timeline */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
          {loadingMessages ? (
            <div className="space-y-4 max-w-3xl mx-auto">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-16 rounded bg-[#111827] border border-slate-800 animate-pulse" />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <div className="max-w-2xl mx-auto py-8 space-y-6">
              <div className="space-y-2 text-center">
                <div className="w-10 h-10 mx-auto rounded bg-blue-600/15 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <Bot className="w-5 h-5" />
                </div>
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Chat with Neo Autonomous Core
                </h2>
                <p className="text-xs text-slate-400 max-w-lg mx-auto leading-relaxed">
                  Ask questions in Persian or English, query Neo&apos;s 7-layer persistent memory, run verified calculations, or switch to Deep Reasoning for 13-stage tool-backed analysis.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {STARTER_PROMPTS.map((item) => {
                  const rtl = isRtlText(item.prompt);
                  return (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => void sendMessage(item.prompt)}
                      className={`p-3.5 rounded bg-[#111827] border border-slate-800 hover:border-blue-500/50 hover:bg-slate-800/40 transition-colors ${
                        rtl ? 'text-right' : 'text-left'
                      }`}
                    >
                      <div dir={rtl ? 'rtl' : 'ltr'} className="text-xs font-semibold text-slate-100">
                        {item.title}
                      </div>
                      <div dir={rtl ? 'rtl' : 'ltr'} className="mt-1 text-[11px] font-mono text-slate-400">
                        {item.subtitle}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-5">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                const rtl = isRtlText(msg.content);
                const meta = msg.metadata || {};
                const runtime = typeof meta.provider === 'string' ? meta.provider : typeof meta.runtime === 'string' ? meta.runtime : null;
                const model = typeof meta.model === 'string' ? meta.model : null;
                const latencyMs = typeof meta.latencyMs === 'number' ? meta.latencyMs : null;
                const tokensPerSec = typeof meta.tokensPerSec === 'number' ? meta.tokensPerSec : null;
                const ragMatches = typeof meta.ragMatches === 'number' ? meta.ragMatches : null;
                const verification =
                  meta.verification && typeof meta.verification === 'object'
                    ? (meta.verification as { passed?: boolean; overallScore?: number; issues?: string[] })
                    : null;
                const isExpanded = expandedDetailsId === msg.id;

                return (
                  <div key={msg.id} className={`flex items-start gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
                    {!isUser && (
                      <div className="w-7 h-7 rounded bg-blue-600/15 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0 mt-0.5">
                        <Bot className="w-3.5 h-3.5" />
                      </div>
                    )}

                    <div
                      className={`max-w-[85%] rounded px-4 py-3 border ${
                        isUser
                          ? 'bg-blue-600/15 border-blue-500/30 text-slate-100'
                          : 'bg-[#111827] border-slate-800 text-slate-200 flex-1'
                      }`}
                    >
                      {isUser ? (
                        <p dir={rtl ? 'rtl' : 'ltr'} className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                      ) : msg.streaming && !msg.content ? (
                        <div className="text-xs font-mono text-slate-400">Thinking...</div>
                      ) : (
                        <SafeMessageRenderer content={msg.content} />
                      )}

                      {!isUser && !msg.streaming && (
                        <div
                          dir="ltr"
                          className="mt-2.5 pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500"
                        >
                          <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                            {runtime && <span>{runtime}</span>}
                            {model && <span>· {model}</span>}
                            {ragMatches !== null && <span>· rag:{ragMatches}</span>}
                            {latencyMs !== null && <span>· {latencyMs}ms</span>}
                            {tokensPerSec !== null && tokensPerSec > 0 && <span>· {tokensPerSec} tok/s</span>}
                            {verification && typeof verification.overallScore === 'number' && (
                              <span className={verification.passed ? 'text-emerald-400' : 'text-amber-400'}>
                                · critic:{verification.overallScore}%
                              </span>
                            )}
                            {!runtime && !model && <span>{formatShortTime(msg.created_at)}</span>}
                          </div>

                          <div className="flex items-center gap-2">
                            {verification && (
                              <button
                                type="button"
                                onClick={() => setExpandedDetailsId(isExpanded ? null : msg.id)}
                                className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 whitespace-nowrap"
                              >
                                <ShieldCheck className="w-3 h-3" />
                                <span>Verify</span>
                                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleCopyMessage(msg.id, msg.content)}
                              className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-200 whitespace-nowrap"
                            >
                              {copiedMessageId === msg.id ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>{copiedMessageId === msg.id ? 'Copied' : 'Copy'}</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {isExpanded && verification && (
                        <div dir="ltr" className="mt-2 p-2.5 rounded bg-[#0B0F17] border border-slate-800 text-[11px] font-mono text-slate-300 space-y-1">
                          <div>
                            Status:{' '}
                            <span className={verification.passed ? 'text-emerald-400' : 'text-amber-400'}>
                              {verification.passed ? 'verified' : 'flagged'}
                            </span>{' '}
                            · Score: {verification.overallScore ?? 'n/a'}%
                          </div>
                          {Array.isArray(verification.issues) && verification.issues.length > 0 && (
                            <div className="text-amber-300">{verification.issues.join(' ')}</div>
                          )}
                        </div>
                      )}
                    </div>

                    {isUser && (
                      <div className="w-7 h-7 rounded bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                        <User className="w-3.5 h-3.5" />
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Sticky Bottom Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
          className="p-3 sm:p-4 bg-[#0D131F] border-t border-slate-800"
        >
          <div className="max-w-3xl mx-auto flex items-end gap-2.5">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              dir="auto"
              rows={2}
              placeholder="پیام خود را به فارسی یا انگلیسی بنویسید... (Enter برای ارسال، Shift+Enter خط جدید)"
              aria-label="Message Neo"
              className="flex-1 px-3.5 py-2.5 bg-[#0B0F17] border border-slate-700 rounded text-xs sm:text-[13px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500 resize-none max-h-40"
            />
            {sending && mode !== 'reasoning' ? (
              <button
                type="button"
                onClick={handleStopStreaming}
                className="h-10 px-4 rounded bg-rose-600 hover:bg-rose-500 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="h-10 px-4 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <SendHorizontal className="w-3.5 h-3.5" />
                <span>{sending ? 'Thinking...' : 'Send'}</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

import { useState } from 'react';

interface ChatMessage {
  id: string;
  user: string;
  message: string;
  timestamp: number;
}

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
}

export function Chat({ messages, onSendMessage }: ChatProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedInput = input.trim();
    if (trimmedInput && trimmedInput.length <= 5000) {
      onSendMessage(trimmedInput.slice(0, 5000));
      setInput('');
    }
  };

  return (
    <div className="glass neon-border p-4 flex-1" style={{ display: 'flex', flexDirection: 'column', minHeight: '150px', borderRadius: '2px' }}>
      <div className="flex gap-2 mb-2 pb-2" style={{ borderBottom: '1px solid rgba(184, 167, 255, 0.3)' }}>
        <button className="px-3 py-1 font-light text-xs uppercase transition-all glass neon-border hover:bg-opacity-60" style={{ color: '#B8A7FF', borderRadius: '2px' }}>
          History
        </button>
        <button className="px-3 py-1 font-light text-xs uppercase transition-all glass neon-border hover:bg-opacity-60" style={{ color: '#B8A7FF', borderRadius: '2px' }}>
          Stats
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto mb-2 space-y-1">
        {messages.length === 0 ? (
          <div className="text-center text-xs py-4 font-light" style={{ color: 'rgba(241, 245, 249, 0.7)' }}>No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className="text-xs" style={{ color: '#F1F5F9' }}>
              <span className="font-light" style={{ color: '#B8A7FF' }}>{msg.user}:</span> {msg.message}
            </div>
          ))
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => {
            const value = e.target.value;
            if (value.length <= 5000) {
              setInput(value);
            }
          }}
          placeholder="Type a message... (max 5000 characters)"
          maxLength={5000}
          className="flex-1 px-3 py-2 font-light text-xs focus:outline-none glass neon-border"
          style={{ 
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            color: '#F1F5F9',
            borderRadius: '2px'
          }}
        />
        <button
          type="submit"
          className="px-4 py-2 font-light text-xs uppercase transition-all glass neon-border hover:bg-opacity-60"
          style={{ 
            color: '#B8A7FF',
            borderRadius: '2px'
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}


import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { CompiledRuleItem } from '../types';

interface RuleBrowserProps {
  onTriggerCompile?: () => void;
}

export const RuleBrowserView: React.FC<RuleBrowserProps> = ({ onTriggerCompile }) => {
  const [rules, setRules] = useState<CompiledRuleItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'blocking' | 'exceptions' | 'cosmetic'>('all');
  const [page, setPage] = useState(0);
  const [pageSize] = useState(100);
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.electron.getCompiledRules({
        search: searchQuery,
        typeFilter,
        offset: page * pageSize,
        limit: pageSize,
      });
      setRules(res.rules || []);
      setTotalCount(res.total || 0);
    } catch (err) {
      console.error('Failed to load compiled rules:', err);
      setRules([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [searchQuery, typeFilter, page, pageSize]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRules();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchRules]);

  const handleCopy = (raw: string, idx: number) => {
    navigator.clipboard.writeText(raw);
    setCopiedIndex(idx);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => setCopiedIndex(null), 1800);
  };

  const totalPages = Math.ceil(totalCount / pageSize);

  const getRuleBadge = (rule: CompiledRuleItem) => {
    if (rule.isException) {
      return <span className="status-badge active" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' }}>Exception</span>;
    }
    if (rule.raw.includes('##') || rule.raw.includes('#@#')) {
      return <span className="status-badge warning" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}>Cosmetic</span>;
    }
    if (rule.raw.startsWith('||') || rule.raw.includes('^')) {
      return <span className="status-badge primary" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', border: '1px solid rgba(99, 102, 241, 0.3)' }}>Network</span>;
    }
    return <span className="status-badge info" style={{ background: 'rgba(14, 165, 233, 0.15)', color: '#38bdf8', border: '1px solid rgba(14, 165, 233, 0.3)' }}>Hosts/DNS</span>;
  };

  return (
    <div className="inspector-view-container" style={{ padding: '24px 32px' }}>
      {/* Header Card */}
      <div className="desktop-card inspector-hero-card" style={{ marginBottom: '20px' }}>
        <div className="inspector-hero-header" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div className="inspector-icon-shield" style={{ background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(168,85,247,0.2))', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '12px', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          </div>
          <div>
            <h2 className="inspector-title" style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>Compiled Rules Browser</h2>
            <p className="inspector-subtitle" style={{ margin: '4px 0 0', opacity: 0.75, fontSize: '0.875rem' }}>
              Search, filter, and inspect the active set of compiled rules directly in memory and on disk.
            </p>
          </div>
        </div>

        {/* Filter controls */}
        <div style={{ marginTop: '20px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: '240px', position: 'relative' }}>
            <input
              type="text"
              className="text-input"
              style={{ width: '100%', paddingLeft: '36px', paddingRight: searchQuery ? '32px' : '12px', height: '40px', borderRadius: '8px' }}
              placeholder="Search rule syntax or domain..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  setPage(0);
                }
              }}
            />
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ position: 'absolute', left: '12px', top: '12px', opacity: 0.5, pointerEvents: 'none' }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setPage(0);
                }}
                style={{
                  position: 'absolute',
                  right: '10px',
                  top: '10px',
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  opacity: 0.6,
                  cursor: 'pointer',
                  fontSize: '14px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                }}
                title="Clear search (Esc)"
              >
                ✕
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '6px', background: 'var(--bg-tertiary, rgba(255,255,255,0.05))', padding: '4px', borderRadius: '8px' }}>
            {(['all', 'blocking', 'exceptions', 'cosmetic'] as const).map((t) => (
              <button
                key={t}
                className={`secondary-button ${typeFilter === t ? 'active-tab' : ''}`}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textTransform: 'capitalize',
                  border: typeFilter === t ? '1px solid var(--accent-primary, #6366f1)' : '1px solid transparent',
                  background: typeFilter === t ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                  color: typeFilter === t ? 'var(--accent-primary, #818cf8)' : 'inherit',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  setTypeFilter(t);
                  setPage(0);
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {onTriggerCompile && (
            <button
              className="primary-button"
              style={{ height: '40px', padding: '0 16px', display: 'flex', alignItems: 'center', gap: '8px' }}
              onClick={onTriggerCompile}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Compile Now
            </button>
          )}
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', fontSize: '0.85rem', opacity: 0.8, flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>
            Showing {rules.length > 0 ? (page * pageSize + 1).toLocaleString() : 0} – {Math.min((page + 1) * pageSize, totalCount).toLocaleString()} of {totalCount.toLocaleString()} rules
          </span>
          {rules.length > 0 && (
            <button
              className="secondary-button"
              style={{ padding: '2px 8px', fontSize: '0.75rem', borderRadius: '4px', cursor: 'pointer' }}
              onClick={() => {
                const text = rules.map((r) => r.raw).join('\n');
                handleCopy(text, -1);
              }}
              title="Copy all rules currently visible on this page"
            >
              {copiedIndex === -1 ? '✓ Copied Page' : 'Copy Page Rules'}
            </button>
          )}
        </div>
        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              className="secondary-button"
              style={{ padding: '4px 10px', fontSize: '0.78rem', cursor: page > 0 ? 'pointer' : 'default', opacity: page > 0 ? 1 : 0.4 }}
              disabled={page <= 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1} of {totalPages}</span>
            <button
              className="secondary-button"
              style={{ padding: '4px 10px', fontSize: '0.78rem', cursor: page < totalPages - 1 ? 'pointer' : 'default', opacity: page < totalPages - 1 ? 1 : 0.4 }}
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Rules Table / List */}
      <div className="desktop-card" style={{ padding: '0', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '48px', textAlign: 'center', opacity: 0.6 }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }}></div>
            Loading rules...
          </div>
        ) : rules.length === 0 ? (
          <div style={{ padding: '64px 24px', textAlign: 'center', opacity: 0.75 }}>
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 16px', opacity: 0.5 }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <h3 style={{ margin: '0 0 8px', fontSize: '1.1rem' }}>No matching rules found</h3>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              {searchQuery ? 'Try adjusting your search terms or filter mode.' : 'Compile your filter lists to browse all generated rules.'}
            </p>
            {!searchQuery && onTriggerCompile && (
              <button
                className="primary-button"
                style={{ marginTop: '16px', padding: '8px 18px', display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                onClick={onTriggerCompile}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Compile Rules Now
              </button>
            )}
          </div>
        ) : (
          <div style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg-tertiary, rgba(255,255,255,0.03))', borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))' }}>
                  <th style={{ padding: '12px 16px', width: '50px' }}>#</th>
                  <th style={{ padding: '12px 16px' }}>Rule Pattern</th>
                  <th style={{ padding: '12px 16px', width: '120px' }}>Category</th>
                  <th style={{ padding: '12px 16px', width: '80px', textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, idx) => (
                  <tr
                    key={idx}
                    style={{
                      borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.05))',
                      transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ padding: '10px 16px', opacity: 0.4, fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {page * pageSize + idx + 1}
                    </td>
                    <td style={{ padding: '10px 16px', fontFamily: 'monospace', wordBreak: 'break-all', color: rule.isException ? '#10b981' : 'inherit' }}>
                      {rule.raw}
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      {getRuleBadge(rule)}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                      <button
                        className="secondary-button"
                        style={{
                          padding: '4px 8px',
                          fontSize: '0.75rem',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          background: copiedIndex === idx ? 'rgba(16, 185, 129, 0.2)' : undefined,
                          color: copiedIndex === idx ? '#10b981' : undefined,
                        }}
                        onClick={() => handleCopy(rule.raw, idx)}
                        title="Copy rule to clipboard"
                      >
                        {copiedIndex === idx ? '✓ Copied' : 'Copy'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

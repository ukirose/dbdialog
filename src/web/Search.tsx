import { ColumnsIcon, SearchIcon, TableIcon } from '@primer/octicons-react';
import { TextInput } from '@primer/react';
import { KeybindingHint } from '@primer/react/experimental';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewTable } from '../core/view';
import { t } from './i18n';
import { type Hit, searchSchema } from './schemaSearch';

/** The search box of the top bar: tables, columns and comments; ⌘K / Ctrl+K focuses it. */
export function Search(props: { tables: ViewTable[]; onPick: (hit: Hit) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchSchema(props.tables, query), [props.tables, query]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (hit: Hit | undefined) => {
    if (!hit) return;
    props.onPick(hit);
    setOpen(false);
    input.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      input.current?.blur();
    }
  };

  const listed = open && query.trim() !== '';
  return (
    <div className="search">
      <TextInput
        ref={input}
        size="small"
        block
        leadingVisual={SearchIcon}
        trailingVisual={<KeybindingHint keys="Mod+k" size="small" />}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
        role="combobox"
        aria-expanded={listed}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={listed && hits[active] ? `search-hit-${active}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {listed && (
        <div
          id="search-results"
          className="search-results"
          role="listbox"
          aria-label={t('search.label')}
        >
          {hits.length === 0 && <div className="search-empty">{t('search.none')}</div>}
          {hits.map((h, i) => (
            <div
              key={`${h.table}\u0000${h.column ?? ''}`}
              id={`search-hit-${i}`}
              role="option"
              // The input keeps the focus; aria-activedescendant points at the active option.
              tabIndex={-1}
              aria-selected={i === active}
              className={`search-hit${i === active ? ' is-active' : ''}`}
              // mousedown, not click: a click would blur the input and close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {h.column ? <ColumnsIcon size={14} /> : <TableIcon size={14} />}
              <span className="search-name">
                {h.column ? (
                  <>
                    <span className="search-table">{h.table}.</span>
                    {h.column}
                  </>
                ) : (
                  h.table
                )}
              </span>
              {h.detail && <span className="search-detail">{h.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

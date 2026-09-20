import React, { useState, useRef, useEffect } from 'react';
import type { FilterSource } from '../types';

const KNOWN_SOURCE_NAMES: Record<string, string> = {
  'https://filters.adtidy.org/extension/chromium/filters/15.txt': 'AdGuard DNS Filter',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt': 'uBlock Filters',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt': 'uBlock Privacy',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt': 'uBlock Badware',
  'https://easylist.to/easylist/easylist.txt': 'EasyList Standard',
  'https://easylist.to/easylist/easyprivacy.txt': 'EasyPrivacy Standard',
  'https://adaway.org/hosts.txt': 'AdAway Default Hosts',
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts': 'StevenBlack Unified Hosts',
  'https://filters.adtidy.org/extension/chromium/filters/2.txt': 'AdGuard Base Filter',
  'https://filters.adtidy.org/extension/chromium/filters/3.txt': 'AdGuard Tracking Protection',
  'https://filters.adtidy.org/extension/chromium/filters/14.txt': 'AdGuard Annoyances Filter',
  'https://filters.adtidy.org/extension/chromium/filters/4.txt': 'AdGuard Social Media Filter',
};

interface BulkImportViewProps {
  currentSources: FilterSource[];
  saveSources: (
    updatedSources: FilterSource[],
    successMsg?: string
  ) => Promise<void>;
  setError: (error: string | null) => void;
  setSuccessMessage: (message: string | null) => void;
}

export const BulkImportView: React.FC<BulkImportViewProps> = ({
  currentSources,
  saveSources,
  setError,
  setSuccessMessage,
}) => {
  const [bulkUrls, setBulkUrls] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      try {
        const text = await file.text();
        setBulkUrls((prev) => (prev ? prev + '\n' + text : text));
        setSuccessMessage(`Loaded URLs from "${file.name}".`);
      } catch (err) {
        setError(`Failed to read dropped file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const resolveSourceName = (url: string, current: FilterSource[], pending: FilterSource[]): string => {
    // 1. Check if URL matches known catalog
    if (KNOWN_SOURCE_NAMES[url]) {
      return KNOWN_SOURCE_NAMES[url];
    }

    // 2. Derive friendly name from path or hostname
    try {
      const parsed = new URL(url);
      const pathSegments = parsed.pathname.split('/').filter(Boolean);
      const lastSegment = pathSegments[pathSegments.length - 1];

      let baseName = '';
      if (lastSegment && lastSegment.endsWith('.txt')) {
        baseName = lastSegment.replace(/\.txt$/, '').replace(/[-_]/g, ' ');
        baseName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
      } else {
        baseName = parsed.hostname.replace(/^www\./, '');
      }

      let name = baseName;
      let counter = 1;
      while (current.concat(pending).some((s) => s.name === name)) {
        name = `${baseName} (${++counter})`;
      }
      return name;
    } catch {
      return 'Custom Feed';
    }
  };

  const handleBulkImport = async () => {
    setError(null);
    setSuccessMessage(null);
    setIsImporting(true);

    const lines = bulkUrls.split('\n');
    const urls = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));

    if (urls.length === 0) {
      setError('No valid URLs found in the input. Please enter valid URLs starting with http:// or https://');
      if (isMountedRef.current) setIsImporting(false);
      return;
    }

    const newSources: FilterSource[] = [];
    const importErrors: string[] = [];
    let skippedCount = 0;

    urls.forEach((url, index) => {
      try {
        new URL(url); // validate
        if (
          currentSources.some((s) => s.url.trim().toLowerCase() === url.toLowerCase()) ||
          newSources.some((s) => s.url.trim().toLowerCase() === url.toLowerCase())
        ) {
          skippedCount++;
          return;
        }

        const resolvedName = resolveSourceName(url, currentSources, newSources);
        newSources.push({ name: resolvedName, url, enabled: true });
      } catch {
        importErrors.push(`Line ${index + 1}: Invalid URL "${url}"`);
      }
    });

    let finalSuccessMessage = '';
    let finalErrorMessage = '';

    if (newSources.length > 0) {
      const updatedSources = [...currentSources, ...newSources];
      try {
        await saveSources(updatedSources);
        finalSuccessMessage =
          `Successfully imported ${newSources.length} new sources.` +
          (skippedCount > 0 ? ` Skipped ${skippedCount} duplicate URLs.` : '');
        if (isMountedRef.current) setBulkUrls('');
      } catch (saveError) {
        finalErrorMessage = `Failed to save imported sources. ${saveError instanceof Error ? saveError.message : ''}`;
      }
    } else if (importErrors.length === 0 && skippedCount > 0) {
      finalSuccessMessage = `All ${skippedCount} URLs were already present in your sources. No duplicates added.`;
    }

    if (importErrors.length > 0) {
      finalErrorMessage =
        (finalErrorMessage ? finalErrorMessage + '\n' : '') +
        `Import errors encountered:\n${importErrors.slice(0, 5).join('\n')}${
          importErrors.length > 5 ? `\n...and ${importErrors.length - 5} more.` : ''
        }`;
    }

    if (finalSuccessMessage) setSuccessMessage(finalSuccessMessage);
    if (finalErrorMessage) setError(finalErrorMessage);

    if (isMountedRef.current) setIsImporting(false);
  };

  const lineCount = bulkUrls.split('\n').filter((l) => l.trim()).length;

  return (
    <div className="bulk-import-container">
      <div
        className={`desktop-card dropzone-card ${isDragging ? 'is-dragging' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="bulk-header-row">
          <div>
            <h3 className="card-section-title">Paste or Drop Filter Feed URLs</h3>
            <p className="card-section-subtitle">
              Enter one filter list URL per line, or drag and drop a <code>.txt</code> or <code>.json</code> file.
              Duplicate URLs are automatically detected and skipped.
            </p>
          </div>
          {lineCount > 0 && (
            <span className="line-counter-chip">{lineCount} line{lineCount === 1 ? '' : 's'}</span>
          )}
        </div>

        {isDragging && (
          <div className="dropzone-overlay">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <span>Drop text file to load URLs</span>
          </div>
        )}

        <textarea
          value={bulkUrls}
          onChange={(e) => setBulkUrls(e.target.value)}
          placeholder="https://easylist.to/easylist/easylist.txt&#10;https://filters.adtidy.org/extension/chromium/filters/15.txt&#10;# Comments and empty lines are ignored automatically"
          rows={10}
          className="bulk-textarea"
        />

        <div className="bulk-actions-footer">
          <div className="bulk-meta-hint">
            <span>Tip: Lines starting with <code>#</code> or <code>!</code> are treated as comments.</span>
          </div>
          <div className="bulk-buttons-group">
            {bulkUrls && (
              <button
                className="secondary-button"
                onClick={() => setBulkUrls('')}
                disabled={isImporting}
              >
                Clear
              </button>
            )}
            <button
              className="primary-button"
              onClick={handleBulkImport}
              disabled={isImporting || lineCount === 0}
            >
              {isImporting ? 'Importing Sources…' : `Import ${lineCount > 0 ? `(${lineCount})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// static/js/models.js

/**
 * Model and provider management
 */

import Storage from './storage.js';
import uiModule from './ui.js?v=20260916largetoolscroll1';
import sessionModule from './sessions.js';
import dragSortModule from './dragSort.js';
import spinnerModule from './spinner.js';
import { modelColor } from './chatRenderer.js?v=20260914metricssummary1';
import { providerLogo } from './providers.js';
import { sortModelIds } from './modelSort.js';

let API_BASE = '';
let _cachedItems = []; // cached /api/models items for model-switch dropdown
let _lastFetchTime = 0;
let _fetchInflight = null;
let _fetchSeq = 0;
const _FETCH_CACHE_TTL = 30000; // 30s client-side cache for /api/models

function _isZeroPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value === 0;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/[\s$,]/g, '').replace(/\/(?:m|1m|million|token|tokens)$/i, '');
  return /^(?:0+(?:\.0+)?|0e[+-]?\d+)$/i.test(normalized);
}

function _hasExplicitFreePricing(item, modelId) {
  const metadata = item?.models_metadata?.[modelId];
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.free === true || metadata.is_free === true || metadata.isFree === true) return true;
  const pricing = metadata.pricing || metadata.prices || metadata.cost || metadata;
  if (!pricing || typeof pricing !== 'object') return false;
  const input = pricing.prompt ?? pricing.input ?? pricing.input_cost ?? pricing.inputCost ?? pricing.prompt_cost;
  const output = pricing.completion ?? pricing.output ?? pricing.output_cost ?? pricing.outputCost ?? pricing.completion_cost;
  return input !== undefined && output !== undefined && _isZeroPrice(input) && _isZeroPrice(output);
}

function _isKnownFreeModel(item, modelId) {
  const mid = String(modelId || '').trim().toLowerCase();
  if (!mid) return false;
  const category = String(item?.category || '').toLowerCase();
  const kind = String(item?.endpoint_kind || item?.endpointKind || '').toLowerCase();
  if (category === 'local' || kind === 'local') return true;
  if (_hasExplicitFreePricing(item, modelId)) return true;
  let host = '';
  try { host = new URL(item?.url || item?.base_url || '', window.location.origin).hostname.toLowerCase(); } catch (_) {}
  const isOpenRouter = host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  return isOpenRouter && (mid === 'openrouter/free' || mid.endsWith(':free'));
}

function _freeOnlyItems(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const filterList = (ids, labels) => (Array.isArray(ids) ? ids : [])
      .map((id, index) => ({ id, label: (Array.isArray(labels) && labels[index]) || id }))
      .filter(entry => _isKnownFreeModel(item, entry.id));
    const primary = filterList(item.models, item.models_display);
    const extras = filterList(item.models_extra, item.models_extra_display);
    const visible = new Set(primary.concat(extras).map(entry => entry.id));
    const metadata = {};
    Object.entries(item.models_metadata || {}).forEach(([id, value]) => {
      if (visible.has(id)) metadata[id] = value;
    });
    return {
      ...item,
      models: primary.map(entry => entry.id),
      models_display: primary.map(entry => entry.label),
      models_extra: extras.map(entry => entry.id),
      models_extra_display: extras.map(entry => entry.label),
      models_metadata: metadata,
    };
  }).filter(item => (item.models || []).length + (item.models_extra || []).length > 0);
}
const COLLAPSE_KEY = 'odysseus-models-collapsed';
const FAVORITES_KEY = 'odysseus-model-favorites';
const USAGE_KEY = 'odysseus-model-usage';
const SORT_KEY = 'odysseus-model-sort';

export function init(apiBase) {
  API_BASE = apiBase;
}

// ── Collapse state persistence ──
function _loadCollapsed() {
  return Storage.getJSON(COLLAPSE_KEY, {});
}
function _saveCollapsed(state) {
  Storage.setJSON(COLLAPSE_KEY, state);
}

// ── Favorites persistence ──
function _loadFavorites() {
  return Storage.getJSON(FAVORITES_KEY, []);
}
function _saveFavorites(list) {
  Storage.setJSON(FAVORITES_KEY, list);
}
function _isFavorite(mid) {
  return _loadFavorites().includes(mid);
}
function _toggleFavorite(mid) {
  const favs = _loadFavorites();
  const idx = favs.indexOf(mid);
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push(mid);
  _saveFavorites(favs);
  return idx < 0; // returns true if now favorited
}

// ── Usage tracking ──
function _loadUsage() {
  return Storage.getJSON(USAGE_KEY, {});
}
function _trackUsage(mid) {
  const usage = _loadUsage();
  if (!usage[mid]) usage[mid] = { count: 0, last: 0 };
  usage[mid].count++;
  usage[mid].last = Date.now();
  Storage.setJSON(USAGE_KEY, usage);
}
function _getSortMode() {
  return Storage.get(SORT_KEY, '');
}
function _setSortMode(mode) {
  Storage.set(SORT_KEY, mode);
}

/**
 * Build a single model row element.
 */
function _startChat(url, mid, endpointId) {
  // Block model switching while compare mode is active.
  if (window.compareModule && window.compareModule.isActive()) return;
  _trackUsage(mid);
  // Route through the chat picker's validated/deferred switch path. This keeps
  // the current transcript visible and only materializes a new session on Send.
  document.dispatchEvent(new CustomEvent('odysseus:select-free-model', {
    detail: { url: url || '', modelId: mid || '', endpointId: endpointId || '' },
  }));
}

function _buildModelRow(mid, url, displayName, endpointId, offline, modelType) {
  const row = document.createElement('div');
  row.className = 'models-row' + (offline ? ' models-row-offline' : '');
  row.setAttribute('data-model-id', mid);
  if (modelType === 'image') row.setAttribute('data-model-type', 'image');

  const handle = document.createElement('span');
  handle.className = 'item-drag-handle';
  handle.textContent = '\u22EE\u22EE';
  handle.title = 'Drag to reorder';
  row.appendChild(handle);

  // Favorite indicator — provider logo or colored dot
  const fav = document.createElement('span');
  const _favColor = modelColor(mid);
  const _logo = providerLogo(mid);
  if (_logo) {
    fav.className = 'model-fav-btn provider-logo' + (_isFavorite(mid) ? ' active' : '');
    fav.innerHTML = _logo;
    fav.style.opacity = '0.4';
  } else {
    fav.className = 'model-fav-btn' + (_isFavorite(mid) ? ' active' : '');
  }
  fav.title = 'Toggle favorite';
  fav.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowFav = _toggleFavorite(mid);
    fav.classList.toggle('active', nowFav);
    uiModule.showToast(nowFav ? 'Favorited' : 'Unfavorited');
    refreshModels();
  });
  const span = document.createElement('span');
  span.className = 'grow';
  span.textContent = displayName.split('/').pop();
  if (modelType === 'image') {
    const badge = document.createElement('span');
    badge.className = 'model-type-badge';
    badge.textContent = 'IMG';
    badge.title = 'Image generation model';
    badge.style.cssText = 'font-size:0.65em;padding:1px 4px;border-radius:3px;background:var(--accent,#7c3aed);color:#fff;margin-left:6px;vertical-align:middle;';
    span.appendChild(badge);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = offline ? 'Offline' : (modelType === 'image' ? '+ Image' : '+ Chat');
  btn.className = 'model-chat-btn';
  btn.style.transition = 'all 0.2s ease';
  if (offline) {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _startChat(url, mid, endpointId);
    });
  }

  // Clicking anywhere on the row (except drag handle and fav) starts a chat
  if (!offline) {
    let _touchMoved = false;
    row.addEventListener('touchstart', () => { _touchMoved = false; }, { passive: true });
    row.addEventListener('touchmove', () => { _touchMoved = true; }, { passive: true });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.item-drag-handle') || e.target.closest('.model-fav-btn')) return;
      if (_touchMoved) { _touchMoved = false; return; }
      _startChat(url, mid, endpointId);
    });
  }

  row.appendChild(fav);
  row.appendChild(span);
  row.appendChild(btn);
  return row;
}

export async function refreshModels(force = false, opts = {}) {
  const box = document.getElementById('models');
  const cacheOnly = !!(opts && opts.cacheOnly);
  const hasCache = _cachedItems.length > 0;

  // Skip network fetch if cache is fresh and not forced — still re-render UI
  // Cache-only is used for cheap picker/settings opens, but it must not turn a
  // cold page load into an empty model list. If nothing has been fetched in this
  // tab yet, do one normal load.
  const now = Date.now();
  const needsFetch = !(cacheOnly && hasCache) && (force || _cachedItems.length === 0 || (now - _lastFetchTime) >= _FETCH_CACHE_TTL);

  const hadRenderedRows = !!(box && box.children && box.children.length);
  if (box && (!needsFetch || !hadRenderedRows)) box.innerHTML = '';
  if (needsFetch) {
    let _loadingSpinner = null;
    if (box) {
      if (hadRenderedRows) {
        box.classList.add('models-refreshing');
      } else {
        _loadingSpinner = spinnerModule.create('', 'right', 'wave');
        box.appendChild(_loadingSpinner.createElement());
        _loadingSpinner.start();
      }
    }
    try {
      if (force) _fetchInflight = null;
      if (!_fetchInflight) {
        // Pass ?refresh=true on forced refreshes so the BACKEND's 30s
        // per-user cache also gets bypassed. Without this, `force=true`
        // only clears the frontend cache and the same stale list comes
        // back — newly-served endpoints don't appear until the cache
        // ages out. (Bug repro: serve a model, picker is empty for ~30s
        // even though the endpoint is in the DB and online.)
        const _seq = ++_fetchSeq;
        const _url = `${API_BASE}/api/models` + (force
          ? `?refresh=true${opts.waitForRefresh ? '&wait_refresh=true' : ''}`
          : '?background=false');
        const _fetchController = new AbortController();
        const _fetchTimeout = setTimeout(() => _fetchController.abort(), 10000);
        _fetchInflight = fetch(_url, { credentials: 'same-origin', signal: _fetchController.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { data, seq: _seq };
          })
          .finally(() => {
            clearTimeout(_fetchTimeout);
            _fetchInflight = null;
          });
      }
      const { data, seq } = await _fetchInflight;
      if (seq < _fetchSeq) return;
      _lastFetchTime = Date.now();
      _cachedItems = _freeOnlyItems(data.items || []);
    } catch (e) {
      console.warn('[Odysseus models] Server model list unavailable; showing the built-in browser model instead.', e);
      // Never leave the Models panel spinning forever. If the server model
      // endpoint is unavailable, continue into the empty-state renderer below,
      // which exposes SmolLM2 as the free on-device default.
      _cachedItems = [];
      _lastFetchTime = Date.now();
    } finally {
      try { _loadingSpinner && _loadingSpinner.stop && _loadingSpinner.stop(); } catch (_) {}
      if (box) box.classList.remove('models-refreshing');
      if (box) box.innerHTML = '';
    }
  }
  if (!box) return;
  try {

    const collapseState = _loadCollapsed();
    let groupIdx = 0; // unique ID counter for drag-sort containers

    // Collect models grouped by category → endpoint
    const groups = { local: {}, api: {} };
    // Also track extra (non-curated) models per endpoint
    const extraGroups = { local: {}, api: {} };
    if (_cachedItems && _cachedItems.length > 0) {
      _cachedItems.forEach(item => {
        const cat = item.category === 'local' ? 'local' : 'api';
        const epName = item.endpoint_name || 'Unknown';
        const isOffline = !!item.offline;
        if (!groups[cat][epName]) groups[cat][epName] = [];
        if (!extraGroups[cat][epName]) extraGroups[cat][epName] = [];
        const displayNames = item.models_display || item.models || [];
        const epModelType = item.model_type || 'llm';
        (item.models || []).forEach((mid, i) => {
          groups[cat][epName].push({
            mid, url: item.url,
            displayName: displayNames[i] || mid,
            endpointId: item.endpoint_id || null,
            offline: isOffline,
            modelType: epModelType,
          });
        });
        // Extra (non-curated) models from server
        const extraDisplayNames = item.models_extra_display || item.models_extra || [];
        (item.models_extra || []).forEach((mid, i) => {
          extraGroups[cat][epName].push({
            mid, url: item.url,
            displayName: extraDisplayNames[i] || mid,
            endpointId: item.endpoint_id || null,
            offline: isOffline,
            modelType: epModelType,
          });
        });
      });
    }

    // ── Render Favorites section on top ──
    const favs = _loadFavorites();
    if (favs.length > 0) {
      const favModels = [];
      // Collect favorited models from all groups (keep them in originals too)
      for (const cat of ['local', 'api']) {
        for (const [epName, epModels] of Object.entries(groups[cat])) {
          for (const m of epModels) {
            if (favs.includes(m.mid)) {
              favModels.push(m);
            }
          }
        }
      }
      // Sort favorites by active sort mode, or by favorited order as default
      const favSort = _getSortMode();
      if (favSort === 'alpha') {
        favModels.sort((a, b) => a.displayName.split('/').pop().localeCompare(b.displayName.split('/').pop()));
      } else if (favSort === 'last-used') {
        const usage = _loadUsage();
        favModels.sort((a, b) => ((usage[b.mid] || {}).last || 0) - ((usage[a.mid] || {}).last || 0));
      } else if (favSort === 'most-used') {
        const usage = _loadUsage();
        favModels.sort((a, b) => ((usage[b.mid] || {}).count || 0) - ((usage[a.mid] || {}).count || 0));
      } else {
        favModels.sort((a, b) => favs.indexOf(a.mid) - favs.indexOf(b.mid));
      }

      if (favModels.length > 0) {
        const favHeader = document.createElement('div');
        favHeader.className = 'models-category-header';
        const favToggle = document.createElement('span');
        favToggle.className = 'folder-toggle';
        const favCollapsed = collapseState['cat:favorites'] === true;
        favToggle.textContent = favCollapsed ? '\u25B6' : '\u25BC';
        favHeader.appendChild(favToggle);
        const favLabel = document.createElement('span');
        favLabel.textContent = 'Favorites';
        favHeader.appendChild(favLabel);
        const favCount = document.createElement('span');
        favCount.className = 'folder-count';
        favCount.textContent = '(' + favModels.length + ')';
        favHeader.appendChild(favCount);
        favHeader.addEventListener('click', () => {
          const s = _loadCollapsed();
          s['cat:favorites'] = !favCollapsed;
          _saveCollapsed(s);
          refreshModels();
        });
        box.appendChild(favHeader);

        if (!favCollapsed) {
          const favContainer = document.createElement('div');
          favContainer.className = 'models-group-content';
          favContainer.id = 'models-group-' + (groupIdx++);
          favModels.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
            favContainer.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
          });
          box.appendChild(favContainer);
        }
      }
    }

    const localCount = Object.values(groups.local).reduce((s, a) => s + a.length, 0);
    const apiCount = Object.values(groups.api).reduce((s, a) => s + a.length, 0);
    const hasMultipleCategories = localCount > 0 && apiCount > 0;
    const needsGrouping = hasMultipleCategories ||
      Object.keys(groups.local).length > 1 || Object.keys(groups.api).length > 1;

    const categoryOrder = [
      { key: 'local', label: 'Local' },
      { key: 'api', label: 'API' },
    ];

    categoryOrder.forEach(({ key, label }) => {
      const endpoints = groups[key];
      const models = Object.values(endpoints).flat();
      if (models.length === 0) return;

      const multiEndpoints = Object.keys(endpoints).length > 1;

      // --- Category-level collapsible group ---
      if (hasMultipleCategories) {
        const catCollapsed = collapseState['cat:' + key] === true;

        const header = document.createElement('div');
        header.className = 'models-category-header';

        const toggle = document.createElement('span');
        toggle.className = 'folder-toggle';
        toggle.textContent = catCollapsed ? '\u25B6' : '\u25BC';
        header.appendChild(toggle);

        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        header.appendChild(labelSpan);

        const count = document.createElement('span');
        count.className = 'folder-count';
        count.textContent = '(' + models.length + ')';
        header.appendChild(count);

        header.addEventListener('click', () => {
          const s = _loadCollapsed();
          s['cat:' + key] = !catCollapsed;
          _saveCollapsed(s);
          refreshModels();
        });

        box.appendChild(header);

        if (catCollapsed) return;
      }

      // --- Endpoint sub-groups ---
      const extraEndpoints = extraGroups[key];
      Object.entries(endpoints).forEach(([epName, epModels]) => {
        const epExtra = extraEndpoints[epName] || [];
        const totalCount = epModels.length + epExtra.length;
        const isOfflineEndpoint = epModels.length > 0 && epModels[0].offline;

        if (multiEndpoints) {
          const epKey = 'ep:' + key + ':' + epName;
          const epCollapsed = collapseState[epKey] === true;

          const sub = document.createElement('div');
          sub.className = 'models-endpoint-label';

          const epToggle = document.createElement('span');
          epToggle.className = 'folder-toggle';
          epToggle.textContent = epCollapsed ? '\u25B6' : '\u25BC';
          sub.appendChild(epToggle);

          const epLabel = document.createElement('span');
          epLabel.textContent = epName;
          sub.appendChild(epLabel);

          if (isOfflineEndpoint) {
            const badge = document.createElement('span');
            badge.className = 'endpoint-offline-badge';
            badge.textContent = '(offline)';
            sub.appendChild(badge);
          }

          const epCount = document.createElement('span');
          epCount.className = 'folder-count';
          epCount.textContent = '(' + totalCount + ')';
          sub.appendChild(epCount);

          sub.addEventListener('click', () => {
            const s = _loadCollapsed();
            s[epKey] = !epCollapsed;
            _saveCollapsed(s);
            refreshModels();
          });

          box.appendChild(sub);

          if (epCollapsed) return;
        }

        // Render model rows into a container
        let target;
        if (needsGrouping) {
          target = document.createElement('div');
          target.className = 'models-group-content';
          target.id = 'models-group-' + (groupIdx++);
          if (multiEndpoints) target.classList.add('indented');
        } else {
          target = box;
        }

        // Apply sort mode
        const sortMode = _getSortMode();
        if (sortMode === 'alpha') {
          epModels.sort((a, b) => a.displayName.split('/').pop().localeCompare(b.displayName.split('/').pop()));
        } else if (sortMode === 'last-used') {
          const usage = _loadUsage();
          epModels.sort((a, b) => ((usage[b.mid] || {}).last || 0) - ((usage[a.mid] || {}).last || 0));
        } else if (sortMode === 'most-used') {
          const usage = _loadUsage();
          epModels.sort((a, b) => ((usage[b.mid] || {}).count || 0) - ((usage[a.mid] || {}).count || 0));
        }

        // Show up to MAX_VISIBLE models, rest behind "show more"
        const MAX_VISIBLE = 5;
        const visible = epModels.slice(0, MAX_VISIBLE);
        const overflow = epModels.slice(MAX_VISIBLE);
        const allHidden = [...overflow, ...epExtra];

        visible.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
          target.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
        });

        if (allHidden.length > 0) {
          const showMoreBtn = document.createElement('div');
          showMoreBtn.className = 'models-show-all-btn';
          showMoreBtn.style.cssText = 'text-align:center;padding:6px;opacity:0.5;cursor:pointer;font-size:0.82em;';
          showMoreBtn.textContent = `Show ${allHidden.length} more model${allHidden.length === 1 ? '' : 's'}`;
          showMoreBtn._target = target;
          showMoreBtn.addEventListener('click', () => {
            showMoreBtn.remove();
            allHidden.forEach(({ mid, url, displayName, endpointId, offline, modelType }) => {
              target.appendChild(_buildModelRow(mid, url, displayName, endpointId, offline, modelType));
            });
          });
          target.appendChild(showMoreBtn);
        }

        if (needsGrouping) box.appendChild(target);
      });
    });

    // Restore saved drag order for flat list before enabling drag-sort
    if (!needsGrouping) {
      const savedModelOrder = Storage.getJSON('models-order', []);
      if (savedModelOrder.length) {
        const rowMap = new Map();
        box.querySelectorAll('.models-row').forEach(r => {
          const mid = r.dataset.modelId;
          if (mid) rowMap.set(mid, r);
        });
        const ordered = [];
        savedModelOrder.forEach(mid => {
          if (rowMap.has(mid)) {
            ordered.push(rowMap.get(mid));
            rowMap.delete(mid);
          }
        });
        // Append remaining rows not in saved order
        rowMap.forEach(r => ordered.push(r));
        ordered.forEach(r => box.appendChild(r));
      }
    }

    // Enable drag sorting
    if (dragSortModule) {
      if (!needsGrouping) {
        // Flat list — sort the whole #models container
        dragSortModule.enable('models', '.models-row', {
          handleSelector: '.item-drag-handle',
          storageKey: 'models-order',
        });
      } else {
        // Grouped — enable sort within each group container
        box.querySelectorAll('.models-group-content').forEach(gc => {
          dragSortModule.enable(gc.id, '.models-row', {
            handleSelector: '.item-drag-handle',
          });
        });
      }
    }

    // ── Search box (shown when >= 5 total models, including hidden overflow) ──
    const totalModelCount = (_cachedItems || []).reduce((n, item) => {
      if (item.offline) return n;
      return n + (item.models || []).length + (item.models_extra || []).length;
    }, 0);
    if (totalModelCount >= 10) {
      const searchBox = document.createElement('input');
      searchBox.type = 'text';
      searchBox.placeholder = 'Search models...';
      searchBox.className = 'model-search-input';
      searchBox.addEventListener('click', (e) => e.stopPropagation());
      searchBox.addEventListener('touchstart', (e) => e.stopPropagation());
      // Container for flat search results (rendered from _cachedItems, ignores collapse)
      const searchResults = document.createElement('div');
      searchResults.className = 'models-search-results';
      searchResults.style.display = 'none';
      box.appendChild(searchResults);

      searchBox.addEventListener('input', () => {
        const q = searchBox.value.toLowerCase().trim();
        if (!q) {
          // Clear search: hide results, restore normal groups
          searchResults.style.display = 'none';
          searchResults.innerHTML = '';
          for (const ch of box.children) {
            if (ch !== searchBox && ch !== searchResults) ch.style.display = '';
          }
          return;
        }
        // Hide all normal groups/headers, show flat search results
        for (const ch of box.children) {
          if (ch !== searchBox && ch !== searchResults) ch.style.display = 'none';
        }
        searchResults.innerHTML = '';
        searchResults.style.display = '';
        // Build flat results from all cached models
        (_cachedItems || []).forEach(item => {
          if (item.offline) return;
          const allModels = (item.models || []).concat(item.models_extra || []);
          const allDisplay = (item.models_display || []).concat(item.models_extra_display || item.models_extra || []);
          allModels.forEach((mid, i) => {
            const display = allDisplay[i] || mid;
            if (!mid.toLowerCase().includes(q) && !display.toLowerCase().includes(q)) return;
            searchResults.appendChild(
              _buildModelRow(mid, item.url, display, item.endpoint_id || null, false, item.model_type || 'llm')
            );
          });
        });
        if (searchResults.children.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'text-align:center;padding:12px;opacity:0.4;';
          empty.textContent = 'No models match "' + searchBox.value.trim() + '"';
          searchResults.appendChild(empty);
        }
      });
      box.insertBefore(searchBox, box.firstChild);
    }

    if (!_cachedItems || _cachedItems.length === 0) {
      const noModels = document.createElement('div');
      noModels.className = 'models-empty-state';
      noModels.innerHTML = '<span class="muted">No free server models are available</span><br>'
        + '<span class="muted-sm">Unverified-price and paid endpoints are hidden from chat. SmolLM2 runs locally on your device at no API cost; first use downloads about 273 MB.</span>'
        + '<div style="margin-top:10px;text-align:left">'
        + '<label for="ody-browser-ai-model" class="muted-sm">Free browser model</label>'
        + '<select id="ody-browser-ai-model" style="width:100%;margin-top:5px">'
        + '<option value="smollm2-local">SmolLM2 · On-device (free)</option>'
        + '</select><div class="muted-sm" id="ody-browser-ai-model-status" style="margin-top:5px">Runs on this device; no hosted model API key is used.</div></div>'

        + (window._isAdmin ? `
          <hr style="margin:12px 0;border-color:var(--border);">
          <div style="margin-top:8px">
            <label class="muted-sm" for="ody-provider-preset">Quick-add a provider</label>
            <select id="ody-provider-preset" style="width:100%;margin-top:5px">
              <option value="">— Select a provider preset —</option>
              <option value="qwen">QwenCloud / DashScope (OpenAI-compatible)</option>
              <option value="hf-router">Hugging Face Router — Free tier available</option>
              <option value="openrouter">OpenRouter — 100+ models</option>
              <option value="together">Together AI — Fast inference</option>
              <option value="groq">Groq — Ultra-fast inference</option>
              <option value="fireworks">Fireworks AI — NVIDIA Nemotron, Llama</option>
              <option value="deepseek">DeepSeek — DeepSeek-V3, R1</option>
              <option value="custom">Custom OpenAI-compatible endpoint…</option>
            </select>
            <div class="muted-sm" id="ody-provider-preset-hint" style="margin-top:5px"></div>
          </div>
        ` : '<div style="margin-top:8px"><a href="#" onclick="document.getElementById(\'user-bar-admin\')?.click();return false;" class="accent-link">Configure a server provider in Admin</a></div>');

      box.appendChild(noModels);
remove unverified browser model catalog
      // Provider preset handler
      const presetSelect = noModels.querySelector('#ody-provider-preset');
      const presetHint = noModels.querySelector('#ody-provider-preset-hint');
      if (presetSelect && presetHint) {
        // Load presets from server
        fetch(`${API_BASE}/api/provider-presets`, { credentials: 'same-origin' })
          .then(r => r.ok ? r.json() : Promise.reject())
          .then(data => {
            const presets = data?.presets || {};
            Object.entries(presets).forEach(([key, preset]) => {
              const opt = document.createElement('option');
              opt.value = key;
              opt.textContent = preset.name;
              presetSelect.appendChild(opt);
            });
            // Add custom option at the end
            const customOpt = document.createElement('option');
            customOpt.value = 'custom';
            customOpt.textContent = 'Custom OpenAI-compatible endpoint…';
            presetSelect.appendChild(customOpt);
          })
          .catch(() => {
            // Fallback to built-in presets if server endpoint unavailable
            const FALLBACK_PRESETS = {
              'qwen': { name: 'QwenCloud / DashScope', base_url: 'https://maas.qwencloudapi.com/compatible-mode/v1', hint: 'Set DASHSCOPE_API_KEY in deployment secrets or paste a newly rotated key into the endpoint form. <a href="https://docs.qwencloud.com/api-reference/preparation/api-key" target="_blank" rel="noopener noreferrer">QwenCloud API key guide</a>.' },
              'hf-router': { name: 'Hugging Face Router', base_url: 'https://router.huggingface.co/v1', hint: 'Requires <a href="https://huggingface.co/settings/tokens" target="_blank">HF_TOKEN</a> with inference permissions. Free tier available.' },
              'openrouter': { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', hint: 'Get key from <a href="https://openrouter.ai/keys" target="_blank">OpenRouter Keys</a>. Access 100+ models.' },
              'together': { name: 'Together AI', base_url: 'https://api.together.xyz/v1', hint: 'Get key from <a href="https://api.together.xyz/settings/api-keys" target="_blank">Together AI</a>. $1 free credit.' },
              'groq': { name: 'Groq', base_url: 'https://api.groq.com/openai/v1', hint: 'Get key from <a href="https://console.groq.com/keys" target="_blank">Groq Console</a>. Free tier: 14.4K req/day.' },
              'fireworks': { name: 'Fireworks AI', base_url: 'https://api.fireworks.ai/inference/v1', hint: 'Get key from <a href="https://fireworks.ai/account/api-keys" target="_blank">Fireworks</a>. Nemotron, Llama models.' },
              'deepseek': { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', hint: 'Get key from <a href="https://platform.deepseek.com/api_keys" target="_blank">DeepSeek Platform</a>. V3, R1 models.' },
            };
            Object.entries(FALLBACK_PRESETS).forEach(([key, preset]) => {
              const opt = document.createElement('option');
              opt.value = key;
              opt.textContent = preset.name;
              presetSelect.appendChild(opt);
            });
            const customOpt = document.createElement('option');
            customOpt.value = 'custom';
            customOpt.textContent = 'Custom OpenAI-compatible endpoint…';
            presetSelect.appendChild(customOpt);
          });

        presetSelect.addEventListener('change', () => {
          const val = presetSelect.value;
          if (!val) {
            presetHint.innerHTML = '';
            return;
          }
          if (val === 'custom') {
            // Open admin panel model endpoint form
            const adminBtn = document.getElementById('user-bar-admin');
            if (adminBtn) adminBtn.click();
            // Try to open model endpoints tab
            setTimeout(() => {
              const modelsTab = document.querySelector('[data-tab="models"]');
              if (modelsTab) modelsTab.click();
              setTimeout(() => {
                const addBtn = document.getElementById('add-model-endpoint-btn') || document.querySelector('[onclick*="addModelEndpoint"]');
                if (addBtn) addBtn.click();
              }, 200);
            }, 200);
            presetHint.innerHTML = 'Opened Admin → Models. Fill in your custom endpoint URL and API key.';
            return;
          }
          // Try to get preset details from server first
          fetch(`${API_BASE}/api/provider-presets`, { credentials: 'same-origin' })
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => {
              const presets = data?.presets || {};
              const preset = presets[val];
              if (!preset) return;
              // Open admin panel and pre-fill the form
              const adminBtn = document.getElementById('user-bar-admin');
              if (adminBtn) adminBtn.click();
              setTimeout(() => {
                const modelsTab = document.querySelector('[data-tab="models"]');
                if (modelsTab) modelsTab.click();
                setTimeout(() => {
                  const addBtn = document.getElementById('add-model-endpoint-btn') || document.querySelector('[onclick*="addModelEndpoint"]');
                  if (addBtn) addBtn.click();
                  setTimeout(() => {
                    const nameInput = document.getElementById('model-endpoint-name');
                    const urlInput = document.getElementById('model-endpoint-base_url');
                    if (nameInput) nameInput.value = preset.name;
                    if (urlInput) urlInput.value = preset.base_url;
                  }, 200);
                }, 200);
              }, 200);
              presetHint.innerHTML = `${preset.name} selected. <strong>Paste your API key</strong> in the Admin → Models form. ${preset.description} <a href="${preset.docs_url}" target="_blank">Get API key</a>.`;
            })
            .catch(() => {
              presetHint.innerHTML = 'Could not load preset details. Please configure manually in Admin → Models.';
            });
        });
      }
    }
  } catch (e) {
    console.error(e);
    box.textContent = '(render failed: ' + e.message + ')';
  }
}

/**
 * Refresh and display OpenAI providers
 */
export async function refreshProviders() {
  const sel = document.getElementById('openai-model');
  if (!sel) return; // Exit if element doesn't exist

  sel.innerHTML = '<option disabled>Loading providers…</option>';

  try {
    const res = await fetch(`${API_BASE}/api/providers`);
    const data = await res.json();
    const openai = (data.providers || []).find(p => p.provider === 'openai');

    sel.innerHTML = '';

    if (openai) {
      const models = (openai.items?.[0]?.models) || [];
      sortModelIds(models).forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(OPENAI_API_KEY not set on server)';
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error(e);
  }
}

export function getCachedItems() { return _cachedItems; }

const modelsModule = {
  init,
  refreshModels,
  refreshProviders,
  getCachedItems,
};

export default modelsModule;
window.modelsModule = modelsModule;

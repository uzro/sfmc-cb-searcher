const button = document.getElementById("refreshde");
const content = document.getElementById("content");
const denameInput = document.getElementById("dename");
const debutton = document.getElementById("desubmit");
const demsg = document.getElementById("output");
const denum = document.getElementById("denum");
const detime = document.getElementById("detime");
const dePanel = document.getElementById("de-panel");
const inputClear = document.getElementById("inputClear");

const STORAGE_KEYS = {
  assetData: "sfmcCbSearcher.assetData",
  assetDataUpdatedAt: "sfmcCbSearcher.assetDataUpdatedAt",
  lastSearch: "sfmcCbSearcher.lastSearch",
  lastSearchResultList: "sfmcCbSearcher.lastSearchResultList",
};

const CATEGORY_PAGE_SIZE = 500;
const ASSET_PAGE_SIZE = 100;
const MAX_ASSET_PAGES_PER_CATEGORY = 20;
const CATEGORY_CONCURRENCY = 4;
const FETCH_RETRY_LIMIT = 3;
const FETCH_RETRY_BASE_MS = 350;
const ASSET_TYPE_IDS = Array.from({ length: 249 }, (_, index) => index + 2);

let mainData = [];

const IS_POPUP_CONTEXT = Boolean(
  button &&
    denameInput &&
    debutton &&
    demsg &&
    denum &&
    detime &&
    dePanel &&
    inputClear
);

if (IS_POPUP_CONTEXT) {
  hydrateFromCache();

  inputClear.addEventListener("click", () => {
    denameInput.value = "";
    demsg.textContent = "";
    dePanel.innerHTML = "";
    localStorage.removeItem(STORAGE_KEYS.lastSearch);
    localStorage.removeItem(STORAGE_KEYS.lastSearchResultList);
  });

  debutton.addEventListener("click", async () => {
    demsg.textContent = "";
    dePanel.innerHTML = "";

    const keyword = denameInput.value.trim();
    if (!keyword) {
      demsg.textContent = "Please enter keyword.";
      return;
    }

    const sortedItems = scoreAndSortAssets(mainData, keyword);

    localStorage.setItem(STORAGE_KEYS.lastSearch, keyword);
    localStorage.setItem(STORAGE_KEYS.lastSearchResultList, JSON.stringify(sortedItems));

    dePanel.appendChild(createMatchListDom(sortedItems, keyword));
  });

  button.addEventListener("click", async () => {
    demsg.textContent = "Refreshing Content Builder assets...";
    dePanel.innerHTML = "";

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];
      if (!currentTab || !currentTab.url || !currentTab.id) {
        demsg.textContent = "No active SFMC tab found.";
        return;
      }

      const [urlDomain] = getDomainAndInstanceId(currentTab.url);
      const urlServer = getServer(urlDomain);

      const csrfToken = await getCsrfToken(currentTab.id, urlServer, currentTab.url);
      if (!csrfToken) {
        demsg.textContent = "CSRF token not found. Open a Content Builder tab and retry.";
        return;
      }

      const categories = await fetchAllCategories(urlServer, csrfToken);
      if (categories.length === 0) {
        demsg.textContent = "No categories found. Open Content Builder and retry.";
        return;
      }

      const categoryPathMap = buildCategoryPathMap(categories);
      const assetMap = new Map();
      let processedCategories = 0;

      await processCategoriesWithConcurrency(
        categories,
        CATEGORY_CONCURRENCY,
        async (category) => {
          const categoryId = category.id;
          const categoryPath =
            categoryPathMap.get(String(categoryId)) ||
            category.name ||
            `Category ${categoryId}`;

          await fetchAssetsByCategory(
            urlServer,
            categoryId,
            csrfToken,
            (pageItems, pageIndex) => {
              for (const asset of pageItems) {
                const normalized = normalizeAsset(asset, categoryPath);
                assetMap.set(normalized.assetId, normalized);
              }

              persistProgress(
                Array.from(assetMap.values()),
                `Refreshing categories: ${processedCategories + 1}/${categories.length}, page ${pageIndex}`
              );
            }
          );

          processedCategories += 1;
          persistProgress(
            Array.from(assetMap.values()),
            `Refreshing categories: ${processedCategories}/${categories.length}`
          );
        }
      );

      mainData = Array.from(assetMap.values());
      persistProgress(
        mainData,
        `Refreshed ${mainData.length} assets from ${categories.length} categories.`
      );
    } catch (error) {
      demsg.textContent = "Please open Content Builder page and refresh again.";
      console.log("refresh error", error);
    }
  });
} else {
  setupCsrfTokenBridge();
}

function hydrateFromCache() {
  const cached = localStorage.getItem(STORAGE_KEYS.assetData);
  if (!cached) {
    return;
  }

  try {
    mainData = JSON.parse(cached);
  } catch (error) {
    mainData = [];
    return;
  }

  denum.textContent = `${mainData.length} Assets`;

  const updatedAt = localStorage.getItem(STORAGE_KEYS.assetDataUpdatedAt);
  if (updatedAt) {
    detime.textContent = updatedAt;
  }

  const lastSearchResultList = localStorage.getItem(STORAGE_KEYS.lastSearchResultList);
  if (lastSearchResultList) {
    const lastSearch = localStorage.getItem(STORAGE_KEYS.lastSearch) || "";
    denameInput.value = lastSearch;
    dePanel.appendChild(createMatchListDom(JSON.parse(lastSearchResultList), lastSearch));
  }
}

function scoreAndSortAssets(assets, keyword) {
  const search = String(keyword || "").trim();
  if (!search) {
    return [];
  }

  const isNumeric = /^\d+$/.test(search);
  const scoredItems = [];

  for (const asset of assets) {
    const score = scoreAsset(asset, search, isNumeric);
    if (score === null) {
      continue;
    }
    scoredItems.push({ asset, score });
  }

  scoredItems.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }

    const aNameLength = String(a.asset.name || "").length;
    const bNameLength = String(b.asset.name || "").length;
    if (aNameLength !== bNameLength) {
      return aNameLength - bNameLength;
    }

    return String(a.asset.name || "").localeCompare(String(b.asset.name || ""));
  });

  return scoredItems.map((item) => item.asset);
}

function scoreAsset(asset, keyword, isNumeric) {
  const normalizedKeyword = normalizeText(keyword);
  const name = normalizeText(asset.name);
  const customerKey = normalizeText(asset.customerKey);
  const assetId = normalizeText(asset.assetId);
  const folderPath = normalizeText(asset.folderPath);

  if (isNumeric) {
    if (assetId === normalizedKeyword) {
      return 0;
    }
    if (assetId.includes(normalizedKeyword)) {
      return 1 + getMatchPenalty(assetId, normalizedKeyword);
    }
    if (name === normalizedKeyword) {
      return 10;
    }
    if (name.includes(normalizedKeyword)) {
      return 20 + getMatchPenalty(name, normalizedKeyword);
    }
    if (customerKey.includes(normalizedKeyword)) {
      return 40 + getMatchPenalty(customerKey, normalizedKeyword);
    }
    if (folderPath.includes(normalizedKeyword)) {
      return 60 + getMatchPenalty(folderPath, normalizedKeyword);
    }
    return null;
  }

  if (name === normalizedKeyword) {
    return 0;
  }
  if (name.startsWith(normalizedKeyword)) {
    return 1 + getMatchPenalty(name, normalizedKeyword);
  }
  if (name.includes(normalizedKeyword)) {
    return 10 + getMatchPenalty(name, normalizedKeyword);
  }
  if (customerKey === normalizedKeyword) {
    return 30;
  }
  if (customerKey.includes(normalizedKeyword)) {
    return 40 + getMatchPenalty(customerKey, normalizedKeyword);
  }
  if (folderPath.includes(normalizedKeyword)) {
    return 60 + getMatchPenalty(folderPath, normalizedKeyword);
  }
  if (assetId.includes(normalizedKeyword)) {
    return 80 + getMatchPenalty(assetId, normalizedKeyword);
  }

  return null;
}

function getMatchPenalty(value, keyword) {
  const index = value.indexOf(keyword);
  const lengthDelta = Math.max(0, value.length - keyword.length);
  return index < 0 ? 1000 : index * 0.1 + lengthDelta * 0.01;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
}

function createMatchListDom(items, keyword) {
  const matchListDom = document.createElement("div");
  matchListDom.className = "match-list";

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const matchItem = document.createElement("div");
    matchItem.className = "match-item";

    if (keyword) {
      matchItem.dataset.matchRank = String(i + 1);
    }

    const title = document.createElement("div");
    title.className = "match-title";
    title.innerHTML = `${i + 1}. ${highlightMatch(item.name, keyword)}`;

    const badges = document.createElement("div");
    badges.className = "match-badges";

    const typeBadge = document.createElement("span");
    typeBadge.className = "match-badge match-badge-type";
    typeBadge.textContent = String(item.assetType || "Unknown");

    const idBadge = document.createElement("span");
    idBadge.className = "match-badge match-badge-id";
    idBadge.textContent = `ID ${item.assetId}`;

    badges.appendChild(typeBadge);
    badges.appendChild(idBadge);

    const folder = document.createElement("div");
    folder.className = "match-folder";
    folder.innerHTML = `Folder: ${highlightMatch(item.folderPath, keyword)}`;

    matchItem.appendChild(title);
    matchItem.appendChild(badges);
    matchItem.appendChild(folder);
    matchListDom.appendChild(matchItem);
  }

  if (items.length === 0) {
    const noMatchItem = document.createElement("div");
    noMatchItem.className = "no-match-item";
    noMatchItem.textContent = "No match found";
    matchListDom.appendChild(noMatchItem);
  }

  return matchListDom;
}

function highlightMatch(text, keyword) {
  const source = String(text || "");
  const search = String(keyword || "").trim();
  if (!search) {
    return escapeHtml(source);
  }

  const sourceLower = source.toLocaleLowerCase();
  const searchLower = search.toLocaleLowerCase();
  const index = sourceLower.indexOf(searchLower);

  if (index < 0) {
    return escapeHtml(source);
  }

  const before = escapeHtml(source.slice(0, index));
  const matched = escapeHtml(source.slice(index, index + search.length));
  const after = escapeHtml(source.slice(index + search.length));
  return `${before}<span class="highlight-keyword">${matched}</span>${after}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchAllCategories(server, csrfToken) {
  const categories = [];
  let page = 1;

  while (true) {
    const endpoint = `https://content-builder.${server}.marketingcloudapps.com/fuelapi/asset/v1/content/categories?$page=${page}&$pagesize=${CATEGORY_PAGE_SIZE}`;
    const data = await fetchJson(endpoint, {
      headers: {
        "x-csrf-token": csrfToken,
      },
    });
    const pageItems = getCollectionFromResponse(data);

    categories.push(...pageItems);

    if (pageItems.length < CATEGORY_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return categories;
}

async function fetchAssetsByCategory(server, categoryId, csrfToken, onPageFetched) {
  const endpoint = `https://content-builder.${server}.marketingcloudapps.com/fuelapi/asset/v1/content/assets/query?scope=ours`;
  const assets = [];

  for (let page = 1; page <= MAX_ASSET_PAGES_PER_CATEGORY; page++) {
    const payload = {
      page: {
        page,
        pageSize: ASSET_PAGE_SIZE,
      },
      sort: [{
        property: "modifiedDate",
        direction: "desc",
      }],
      query: {
        leftOperand: {
          property: "category.id",
          simpleOperator: "equals",
          value: categoryId,
        },
        logicalOperator: "AND",
        rightOperand: {
          property: "assetType.id",
          simpleOperator: "in",
          values: ASSET_TYPE_IDS,
        },
      },
    };

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify(payload),
    });

    const pageItems = getCollectionFromResponse(data);
    assets.push(...pageItems);

    if (onPageFetched) {
      onPageFetched(pageItems, page);
    }

    if (pageItems.length < ASSET_PAGE_SIZE) {
      break;
    }
  }

  return assets;
}

async function processCategoriesWithConcurrency(categories, concurrency, handler) {
  const queue = categories.slice();
  const workerCount = Math.max(1, Math.min(concurrency, queue.length));

  async function worker() {
    while (queue.length > 0) {
      const category = queue.shift();
      if (!category) {
        return;
      }
      await handler(category);
    }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
}

function persistProgress(items, message) {
  mainData = items;

  const now = getCurrentDateTime();
  denum.textContent = `${mainData.length} Assets`;
  detime.textContent = now;
  demsg.textContent = message;

  localStorage.setItem(STORAGE_KEYS.assetData, JSON.stringify(mainData));
  localStorage.setItem(STORAGE_KEYS.assetDataUpdatedAt, now);
}

function getCollectionFromResponse(data) {
  if (Array.isArray(data.items)) {
    return data.items;
  }
  if (Array.isArray(data.entry)) {
    return data.entry;
  }
  if (Array.isArray(data.results)) {
    return data.results;
  }
  return [];
}

function normalizeAsset(asset, fallbackFolderPath) {
  return {
    assetId: asset.id,
    name: asset.name || "(No Name)",
    customerKey: asset.customerKey || "",
    assetType: (asset.assetType && (asset.assetType.name || asset.assetType.id)) || "Unknown",
    folderPath: fallbackFolderPath || "/",
    modifiedDate: asset.modifiedDate || "",
  };
}

function dedupeByAssetId(assets) {
  const map = new Map();
  for (const asset of assets) {
    map.set(asset.assetId, asset);
  }
  return Array.from(map.values());
}

function buildCategoryPathMap(categories) {
  const categoryById = new Map();
  const pathMap = new Map();

  function normalizeId(value) {
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  }

  for (const category of categories) {
    categoryById.set(normalizeId(category.id), category);
  }

  function getParentId(category) {
    if (!category) {
      return null;
    }
    if (typeof category.parentId === "number") {
      return normalizeId(category.parentId);
    }
    if (typeof category.parentCategoryId === "number" || typeof category.parentCategoryId === "string") {
      return normalizeId(category.parentCategoryId);
    }
    if (category.parent && (typeof category.parent.id === "number" || typeof category.parent.id === "string")) {
      return normalizeId(category.parent.id);
    }
    return null;
  }

  function buildPath(categoryId, visited = new Set()) {
    const normalizedCategoryId = normalizeId(categoryId);

    if (pathMap.has(normalizedCategoryId)) {
      return pathMap.get(normalizedCategoryId);
    }

    const category = categoryById.get(normalizedCategoryId);
    if (!category) {
      return "/";
    }

    if (visited.has(normalizedCategoryId)) {
      return category.name || `Category ${normalizedCategoryId}`;
    }

    visited.add(normalizedCategoryId);

    const ownName = category.name || `Category ${normalizedCategoryId}`;
    const parentId = getParentId(category);

    if (!parentId || parentId === normalizedCategoryId || !categoryById.has(parentId)) {
      pathMap.set(normalizedCategoryId, ownName);
      return ownName;
    }

    const parentPath = buildPath(parentId, visited);
    const fullPath = `${parentPath}/${ownName}`;
    pathMap.set(normalizedCategoryId, fullPath);
    return fullPath;
  }

  for (const category of categories) {
    buildPath(category.id);
  }

  return pathMap;
}

async function fetchJson(url, options = {}, attempt = 0) {
  const mergedOptions = {
    credentials: "include",
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  };

  try {
    const response = await fetch(url, mergedOptions);
    if (!response.ok) {
      const bodyText = await response.text();
      const retryableStatus = response.status === 429 || response.status >= 500;
      const proxyFailed = bodyText.includes("PROXY_FAILED");

      if ((retryableStatus || proxyFailed) && attempt < FETCH_RETRY_LIMIT) {
        await sleep(FETCH_RETRY_BASE_MS * (attempt + 1));
        return fetchJson(url, options, attempt + 1);
      }

      throw new Error(`Request failed: ${response.status} ${bodyText.slice(0, 120)}`);
    }

    return response.json();
  } catch (error) {
    const msg = String((error && error.message) || error);
    const retryableNetworkError =
      msg.includes("PROXY_FAILED") ||
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError");

    if (retryableNetworkError && attempt < FETCH_RETRY_LIMIT) {
      await sleep(FETCH_RETRY_BASE_MS * (attempt + 1));
      return fetchJson(url, options, attempt + 1);
    }

    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCsrfToken(tabId, server, activeTabUrl) {
  const contentBuilderUrl = `https://content-builder.${server}.marketingcloudapps.com/`;

  const tokenFromCookieApi =
    (await getCookieByName(contentBuilderUrl, "_csrf")) ||
    (await getCookieByName(activeTabUrl, "_csrf"));

  if (tokenFromCookieApi) {
    return tokenFromCookieApi;
  }

  return getCsrfTokenFromTab(tabId);
}

async function getCsrfTokenFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "SFMC_CB_GET_CSRF_TOKEN",
    });
    return (response && response.token) || "";
  } catch (error) {
    console.log("csrf token read error", error);
    return "";
  }
}

async function getCookieByName(url, name) {
  if (!url || !chrome.cookies || !chrome.cookies.get) {
    return "";
  }

  return new Promise((resolve) => {
    chrome.cookies.get({ url, name }, (cookie) => {
      const lastError = chrome.runtime && chrome.runtime.lastError;
      if (lastError || !cookie || !cookie.value) {
        resolve("");
        return;
      }

      try {
        resolve(decodeURIComponent(cookie.value));
      } catch (_error) {
        resolve(cookie.value);
      }
    });
  });
}

function setupCsrfTokenBridge() {
  if (!chrome.runtime || !chrome.runtime.onMessage) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "SFMC_CB_GET_CSRF_TOKEN") {
      return;
    }

    sendResponse({ token: extractCsrfTokenFromPage() });
  });
}

function extractCsrfTokenFromPage() {
  const csrfFromCookie = getCsrfTokenFromCookieString(document.cookie);
  if (csrfFromCookie) {
    return csrfFromCookie;
  }

  const metaSelectors = [
    'meta[name="csrf-token"]',
    'meta[name="x-csrf-token"]',
    'meta[name="_csrf"]',
  ];

  for (const selector of metaSelectors) {
    const token = document.querySelector(selector)?.getAttribute("content");
    if (token) {
      return token;
    }
  }

  const cookieCandidates = ["XSRF-TOKEN", "xsrf-token", "csrf-token", "csrf"];

  for (const name of cookieCandidates) {
    const value = getCookieValue(name);
    if (value) {
      try {
        return decodeURIComponent(value);
      } catch (_error) {
        return value;
      }
    }
  }

  return "";
}

function getCsrfTokenFromCookieString(cookieStr) {
  if (!cookieStr) {
    return "";
  }

  const parts = cookieStr.split(";");
  for (const part of parts) {
    const [rawName, ...rest] = part.split("=");
    if (!rawName || rest.length === 0) {
      continue;
    }

    const name = rawName.trim();
    if (name !== "_csrf") {
      continue;
    }

    const rawValue = rest.join("=").trim();
    if (!rawValue) {
      return "";
    }

    try {
      return decodeURIComponent(rawValue);
    } catch (_error) {
      return rawValue;
    }
  }

  return "";
}

function getCookieValue(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? match[1] : "";
}

function getServer(url) {
  const match = url.match(/s\d+/i);
  return match ? match[0] : "s12";
}

function getDomainAndInstanceId(url) {
  const parsedUrl = new URL(url);
  const domain = parsedUrl.hostname;
  const instanceId = parsedUrl.hash.slice(9).split("/")[1];
  return [domain, instanceId];
}

function getCurrentDateTime() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hours = now.getHours().toString().padStart(2, "0");
  const minutes = now.getMinutes().toString().padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

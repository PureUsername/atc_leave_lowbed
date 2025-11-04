import { apiGet, apiPost, addDays, fmt, normalizeDriver, qs, qsa, toast } from "./common.js";

const state = {
  drivers: [],
  weekendDays: [6, 0],
  selected: { start: null, end: null },
  hasFullDay: false,
  pendingForceStart: null,
  pendingForceDriverId: null,
  pendingForceNotification: null,
  maxPerDay: 3,
  categoryGroups: [],
  categoryGroupLookup: {},
};

const LOWBED_CHAT_ID = "120363406616265454@g.us"; // happy
const ADMIN_CHAT_ID = "120363368545737149@g.us"; // mix
const driverSelect = qs("#driverSelect");
const capacityHintContainer = qs("#capacityHints");
const statusLabel = qs("#status");
const dateRangeInput = qs("#dateRange");
const forceModal = qs("#forceModal");
const calendarUpdateMode =
  document.querySelector("[data-calendar-update-mode]")?.dataset?.calendarUpdateMode || "after_approval";
let dateRangePicker = null;
const driverCategoryFilterMeta = document.querySelector('meta[name="driver-category-filter"]') || null;

const DEFAULT_CATEGORY_GROUPS = [
  { id: "LOWBED", label: "LOWBED", categories: ["LOWBED"] },
  { id: "12WHEEL_TRAILER", label: "12WHEEL + TRAILER", categories: ["12WHEEL", "TRAILER"] },
  { id: "KSK", label: "KSK", categories: ["KSK"] },
];

const normalizeCategoryKey = (value) => (value == null ? "" : String(value)).trim().toUpperCase();

const normalizeCategoryGroups = (groups = []) => {
  const normalized = [];
  if (Array.isArray(groups)) {
    groups.forEach((group, index) => {
      if (!group || typeof group !== "object") {
        return;
      }
      const id = normalizeCategoryKey(group.id || group.group || `GROUP_${index + 1}`);
      if (!id) {
        return;
      }
      const labelSource = group.label || group.name || id;
      const label = typeof labelSource === "string" && labelSource.trim() ? labelSource.trim() : id;
      const categories = Array.isArray(group.categories)
        ? group.categories.map((category) => normalizeCategoryKey(category)).filter(Boolean)
        : [];
      normalized.push({ id, label, categories });
    });
  }
  if (!normalized.length) {
    return DEFAULT_CATEGORY_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      categories: [...group.categories],
    }));
  }
  return normalized;
};

const buildCategoryLookup = (groups) => {
  const lookup = {};
  groups.forEach((group) => {
    group.categories.forEach((category) => {
      const key = normalizeCategoryKey(category);
      if (key) {
        lookup[key] = group.id;
      }
    });
  });
  return lookup;
};

const setCategoryGroups = (groups) => {
  const normalized = normalizeCategoryGroups(groups);
  state.categoryGroups = normalized;
  state.categoryGroupLookup = buildCategoryLookup(normalized);
};

const getCategoryGroupMeta = (groupId) => {
  if (!groupId) {
    return null;
  }
  const normalizedId = normalizeCategoryKey(groupId);
  return state.categoryGroups.find((group) => group.id === normalizedId) || null;
};

const resolveCategoryGroupId = (category) => {
  const key = normalizeCategoryKey(category);
  if (!key) {
    return "";
  }
  return state.categoryGroupLookup[key] || key;
};

const formatCategoryGroupLabel = (groupId) => {
  if (!groupId) {
    return "Kategori";
  }
  const normalizedId = normalizeCategoryKey(groupId);
  if (normalizedId === "ALL") {
    return "Semua";
  }
  const meta = getCategoryGroupMeta(normalizedId);
  return meta?.label || groupId;
};

const resolveCategoryGroupFromToken = (token) => {
  const normalized = normalizeCategoryKey(token);
  if (!normalized) {
    return "";
  }
  if (state.categoryGroups.some((group) => group.id === normalized)) {
    return normalized;
  }
  return state.categoryGroupLookup[normalized] || "";
};

const getFilteredCategoryGroup = () => {
  const filterState = getActiveDriverCategoryFilter();
  if (!filterState?.hasFilter) {
    return "";
  }
  for (const token of filterState.categories) {
    const resolved = resolveCategoryGroupFromToken(token);
    if (resolved) {
      return resolved;
    }
  }
  return "";
};

setCategoryGroups(DEFAULT_CATEGORY_GROUPS);

const normalizeCategoryValue = (value) => (value == null ? "" : String(value)).trim().toLowerCase();

const splitCategoryTokens = (input = "") =>
  String(input)
    .split(/[,|]/)
    .map((token) => normalizeCategoryValue(token))
    .filter(Boolean);

const collectHiddenCategoryFilters = () => {
  const tokens = [];
  const selectFilter = driverSelect?.dataset?.categoryFilter || "";
  if (selectFilter) {
    tokens.push(selectFilter);
  }
  const metaValue = driverCategoryFilterMeta?.content || "";
  if (metaValue) {
    tokens.push(metaValue);
  }
  qsa("[data-driver-category-filter]").forEach((node) => {
    if (!node) {
      return;
    }
    const datasetValue = node.dataset?.categories;
    if (datasetValue) {
      tokens.push(datasetValue);
      return;
    }
    if (typeof node.value === "string") {
      tokens.push(node.value);
      return;
    }
    const textValue = node.textContent;
    if (typeof textValue === "string") {
      tokens.push(textValue);
    }
  });
  const params = new URLSearchParams(window.location.search);
  const queryValues = [
    ...params.getAll("driver_category"),
    ...params.getAll("driver_categories"),
    params.get("driverCategoryFilter") || "",
  ].filter(Boolean);
  tokens.push(...queryValues);
  return Array.from(new Set(tokens.flatMap(splitCategoryTokens)));
};

const getActiveDriverCategoryFilter = () => {
  const categories = collectHiddenCategoryFilters();
  return {
    categories,
    hasFilter: categories.length > 0,
  };
};

const driverMatchesActiveFilter = (driver, filterState) => {
  if (!driver || driver.active === false) {
    return false;
  }
  if (!filterState?.hasFilter) {
    return true;
  }
  const category = normalizeCategoryValue(driver.category || "");
  return category && filterState.categories.includes(category);
};

const setCapacityMessage = (message) => {
  if (!capacityHintContainer) return;
  capacityHintContainer.innerHTML = `<p class="text-slate-500">${message}</p>`;
};

const setStatus = (message) => {
  if (statusLabel) {
    statusLabel.textContent = message || "";
  }
};

const resetPendingForceState = () => {
  state.pendingForceStart = null;
  state.pendingForceDriverId = null;
  state.pendingForceNotification = null;
};

const showForceModal = () => {
  forceModal?.classList.remove("hidden");
};

const hideForceModal = () => {
  forceModal?.classList.add("hidden");
};

const getDriverById = (driverId) => {
  if (!driverId) {
    return null;
  }
  return state.drivers.find((driver) => driver.driver_id === driverId) || null;
};

const formatDateRangeCaption = (dates) => {
  if (!Array.isArray(dates) || !dates.length) {
    return "";
  }
  const sorted = [...dates].filter(Boolean).sort();
  const start = sorted[0];
  const end = sorted[sorted.length - 1];
  return start === end ? start : `${start} - ${end}`;
};

const buildSnapshotCaption = (driver, dates) => {
  if (!driver) {
    return formatDateRangeCaption(dates);
  }
  const driverName = (driver.display_name || driver.driver_id || "").trim() || "Driver";
  const category = (driver.category || "").trim();
  const range = formatDateRangeCaption(dates);
  return category ? `${driverName} (${category}) ${range}` : `${driverName} ${range}`;
};

const toWhatsappJid = (value) => {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  if (/@[cg]\.us$/i.test(trimmed)) {
    return trimmed;
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) {
    return null;
  }
  let normalized = digits;
  if (normalized.startsWith("60")) {
    // already in international format
  } else if (normalized.startsWith("0") && normalized.length > 1) {
    normalized = `6${normalized.slice(1)}`;
  }
  return `${normalized}@c.us`;
};

const buildSnapshotAttachment = async (dates = [], driver = null) => {
  if (!Array.isArray(dates) || !dates.length || !driver) {
    return null;
  }
  const months = uniqueMonthsFromDates(dates);
  if (!months.length) {
    return null;
  }
  const snapshotMonth = months[0];
  try {
    const base64Image = await fetchMonthSnapshotAsBase64(snapshotMonth);
    const driverPart = sanitizeFilenamePart(driver?.driver_id || driver?.display_name || "driver");
    const imageFilename = `calendar-${snapshotMonth}-${driverPart}.jpg`;
    return { base64Image, imageFilename, snapshotMonth };
  } catch (error) {
    console.error("Failed to get calendar snapshot for notification", error);
    return null;
  }
};

const parseBoolean = (value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
};

const formatDriverDescriptorClient = (driver = {}, fallback = "") => {
  if (!driver || typeof driver !== "object") {
    return fallback;
  }
  const displayName = String(driver.display_name || driver.displayName || "").trim();
  const driverId = String(driver.driver_id || driver.driverId || "").trim();
  const category = String(driver.category || "").trim();

  const hasDisplay = Boolean(displayName);
  const hasDriverId = Boolean(driverId);
  const namePart =
    hasDisplay && hasDriverId && displayName.toLowerCase() !== driverId.toLowerCase()
      ? `${displayName} / ${driverId}`
      : hasDisplay
      ? displayName
      : driverId || fallback;

  const categoryPart = category ? category.trim().toUpperCase() : "";
  if (!categoryPart) {
    return namePart || fallback;
  }
  if (!namePart) {
    return `(${categoryPart})`;
  }
  return `${namePart} (${categoryPart})`;
};

const extractApplicantDescriptor = (notification = {}) => {
  const rawMessage = typeof notification.message === "string" ? notification.message : "";
  if (rawMessage) {
    const lines = rawMessage
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length >= 2) {
      return lines[1];
    }
  }
  return formatDriverDescriptorClient(notification.applicant, "");
};

const getDateRangeLabelFromNotification = (notification = {}) => {
  const metadataLabel = notification?.metadata?.date_range_label;
  if (metadataLabel && typeof metadataLabel === "string" && metadataLabel.trim()) {
    return metadataLabel.trim();
  }
  const dateRange = notification.date_range || {};
  const start = typeof dateRange.start === "string" ? dateRange.start.trim() : "";
  const end = typeof dateRange.end === "string" ? dateRange.end.trim() : "";
  if (start && end) {
    return start === end ? start : `${start} - ${end}`;
  }
  return start || end || "";
};

const buildApprovalChatBody = (notification = {}) => {
  const dateRangeLabel = getDateRangeLabelFromNotification(notification);
  const capacityIssue =
    parseBoolean(notification.capacity_issue) ||
    parseBoolean(notification?.metadata?.capacity_issue);

  const prefixMs = capacityIssue
    ? "Permohonan cuti baharu pada (kerana mencapai had maksimum 3 orang sehari)"
    : "Permohonan cuti baharu pada";

  const bodyLine = `${prefixMs}${dateRangeLabel ? ` ${dateRangeLabel}` : ""}:`.trim();

  const applicantDescriptor = extractApplicantDescriptor(notification);

  return [bodyLine, applicantDescriptor].filter(Boolean).join("\n");
};

const buildNotificationChatBodyZh = (notification = {}) => {
  const dateRangeLabel = getDateRangeLabelFromNotification(notification);
  const capacityIssue =
    parseBoolean(notification.capacity_issue) ||
    parseBoolean(notification?.metadata?.capacity_issue);

  const lines = [];
  if (capacityIssue) {
    lines.push(
      `因当天请假人数已达上限（3人），新的请假申请将改至 ${dateRangeLabel || "所选日期"}:`
    );
  } else if (dateRangeLabel) {
    lines.push(`新的请假申请：${dateRangeLabel}`);
  } else {
    lines.push("新的请假申请已提交。");
  }

  const applicantDescriptor = extractApplicantDescriptor(notification);
  if (applicantDescriptor) {
    lines.push(applicantDescriptor);
  }

  const takenSummary = notification?.taken_summary;
  const summaryEntries =
    takenSummary && typeof takenSummary === "object"
      ? Object.entries(takenSummary)
      : [];

  if (summaryEntries.length) {
    lines.push("");
    lines.push("司机已请假日期:");
    summaryEntries.forEach(([date, names], index) => {
      const safeDate = typeof date === "string" ? date.trim() + ":" : "";
      lines.push(safeDate);
      if (Array.isArray(names) && names.length) {
        names.forEach((descriptor) => {
          if (descriptor) {
            lines.push(descriptor);
          }
        });
      }
      if (index < summaryEntries.length - 1) {
        lines.push("");
      }
    });
  }

  return lines.join("\n").trim();
};

const sendLeaveNotificationWithSnapshot = async (notification = {}, dates = [], driver = null) => {
  if (!notification.message) {
    return;
  }

  const buttonActionSource =
    notification.button_actions && typeof notification.button_actions === "object"
      ? notification.button_actions
      : {};
  const buttons = Object.entries(buttonActionSource)
    .map(([label, action]) => {
      const body = String(label || "").trim();
      const mappedAction = typeof action === "string" ? action.trim() : "";
      if (!body) {
        return null;
      }
      return mappedAction
        ? { body, id: mappedAction }
        : { body };
    })
    .filter(Boolean);

  if (!buttons.length && Array.isArray(notification.buttons)) {
    notification.buttons.forEach((btn) => {
      const body = (btn?.body || btn?.label || "").trim();
      const id = (btn?.id || btn?.customId || "").trim?.() || "";
      if (body) {
        buttons.push(id ? { body, id } : { body });
      }
    });
  }

  if (!buttons.length) {
    return;
  }

  const mentionNumbers = Array.isArray(notification.mention_numbers)
    ? notification.mention_numbers.filter(Boolean)
    : [];
  const mentionJids = mentionNumbers
    .map(toWhatsappJid)
    .filter(Boolean);

  if (!notification.metadata || typeof notification.metadata !== "object") {
    notification.metadata = {};
  }
  if (!notification.metadata.calendar_update_mode) {
    notification.metadata.calendar_update_mode = calendarUpdateMode;
  }

  const metadataSource =
    notification.metadata && typeof notification.metadata === "object"
      ? notification.metadata
      : {};
  const metadata = {};
  Object.entries(metadataSource).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    metadata[key] =
      typeof value === "object" ? JSON.stringify(value) : String(value);
  });

  if (!metadata.button_actions_json && Object.keys(buttonActionSource).length) {
    metadata.button_actions_json = JSON.stringify(buttonActionSource);
  }
  if (!metadata.request_id && notification.request_id) {
    metadata.request_id = String(notification.request_id);
  }
  if (!metadata.calendar_update_mode) {
    metadata.calendar_update_mode = calendarUpdateMode;
  }

  const approvalBody = buildApprovalChatBody(notification) || notification.message;
  const approvalPayload = {
    chatId: LOWBED_CHAT_ID,
    content: approvalBody,
    type: "text",
  };
  if (mentionNumbers.length) {
    approvalPayload.mentionNumbers = mentionNumbers;
  }
  if (mentionJids.length) {
    approvalPayload.mentions = mentionJids;
  }

  const notificationBodyZh = buildNotificationChatBodyZh(notification) || approvalBody;
  const zhButtons = buttons.map((btn) => {
    const id = btn.id;
    if (!id) {
      return btn;
    }
    if (id.includes(":approve:")) {
      return { body: "批准", id };
    }
    if (id.includes(":reject:")) {
      return { body: "拒绝", id };
    }
    return btn;
  });

  const chineseApprovalPayload = {
    chatId: ADMIN_CHAT_ID,
    type: "buttons",
    body: notificationBodyZh,
    buttons: zhButtons,
    title: "请假审批状态",
    footer: "请选择按钮以更新决定。",
    metadata,
  };
  if (mentionNumbers.length) {
    chineseApprovalPayload.mentionNumbers = mentionNumbers;
  }
  if (mentionJids.length) {
    chineseApprovalPayload.mentions = mentionJids;
  }

  try {
    await apiPost("whatsapp_send", chineseApprovalPayload);
    await apiPost("whatsapp_send", approvalPayload);
  } catch (error) {
    console.error("Failed to send leave notification", error);
    toast(
      `Gagal menghantar mesej kelulusan: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const monthFromIsoDate = (isoDate) => (typeof isoDate === "string" && isoDate.length >= 7 ? isoDate.slice(0, 7) : null);

const uniqueMonthsFromDates = (dates) => {
  const months = new Set();
  (dates || []).forEach((iso) => {
    const key = monthFromIsoDate(iso);
    if (key) {
      months.add(key);
    }
  });
  return Array.from(months).sort();
};

const svgStringToDataUrl = (svgString) =>
  new Promise((resolve, reject) => {
    try {
      const blob = new Blob([svgString], { type: "image/svg+xml" });
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read SVG string."));
      reader.readAsDataURL(blob);
    } catch (error) {
      reject(error);
    }
  });

const svgPayloadToDataUrl = async (payload) => {
  if (payload?.svgDataUrl && typeof payload.svgDataUrl === "string") {
    return payload.svgDataUrl;
  }
  if (payload?.svg && typeof payload.svg === "string") {
    return svgStringToDataUrl(payload.svg);
  }
  throw new Error("Snapshot payload missing SVG data.");
};

const loadImageFromDataUrl = (dataUrl) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode snapshot image."));
    img.src = dataUrl;
  });

const svgDataUrlToJpegBase64 = async (dataUrl) => {
  const image = await loadImageFromDataUrl(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    throw new Error("Snapshot image has invalid dimensions.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to access canvas context.");
  }
  ctx.drawImage(image, 0, 0, width, height);
  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const [, base64] = jpegDataUrl.split(",");
  if (!base64) {
    throw new Error("Failed to encode snapshot image.");
  }
  return base64;
};

const fetchMonthSnapshotAsBase64 = async (month) => {
  const data = await apiGet("calendar_screenshot", { month });
  if (!data?.ok) {
    throw new Error(data?.message || "Snapshot not available.");
  }
  const svgDataUrl = await svgPayloadToDataUrl(data);
  return svgDataUrlToJpegBase64(svgDataUrl);
};

const sanitizeFilenamePart = (value) => {
  if (!value) {
    return "file";
  }
  const clean = String(value).trim().replace(/[^\w.-]+/g, "_");
  return clean || "file";
};

const renderDriverOptions = () => {
  if (!driverSelect) return;
  const previousValue = driverSelect.value;
  driverSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Pilih nama";
  placeholder.disabled = true;
  driverSelect.appendChild(placeholder);
  let restoredSelection = false;
  const filterState = getActiveDriverCategoryFilter();
  const filteredDrivers = state.drivers.filter((driver) => driverMatchesActiveFilter(driver, filterState));
  driverSelect.dataset.activeCategoryFilter = filterState.categories.join(",") || "";
  filteredDrivers.forEach((driver) => {
    const opt = document.createElement("option");
    opt.value = driver.driver_id || "";
    const name = driver.display_name || driver.driver_id || "Unnamed Driver";
    opt.textContent = `${name}${driver.category ? ` (${driver.category})` : ""}`;
    driverSelect.appendChild(opt);
    if (!restoredSelection && opt.value && opt.value === previousValue) {
      restoredSelection = true;
    }
  });
  if (!filteredDrivers.length && filterState.hasFilter) {
    placeholder.textContent = "Tiada pemandu tersedia untuk kategori ini";
  }
  if (restoredSelection) {
    driverSelect.value = previousValue;
    placeholder.selected = false;
  } else {
    placeholder.selected = true;
  }
};

const collectSelectedDates = () => {
  const { start, end } = state.selected;
  if (!start || !end) {
    return [];
  }
  const dates = [];
  let cursor = new Date(start);
  const endDate = new Date(end);
  while (cursor <= endDate) {
    dates.push(fmt(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
};

const getCapacityStatusClass = (count, max) => {
  if (count >= max) {
    return "text-red-600";
  }
  if (count === max - 1) {
    return "text-amber-600";
  }
  return "text-emerald-600";
};

const refreshCapacityHints = async () => {
  if (!capacityHintContainer) {
    return;
  }
  const dates = collectSelectedDates();
  capacityHintContainer.innerHTML = "";
  if (!dates.length) {
    state.hasFullDay = false;
    setStatus("");
    setCapacityMessage("Sila pilih julat tarikh untuk melihat kapasiti.");
    return;
  }
  const from = dates[0];
  const to = dates[dates.length - 1];
  state.hasFullDay = false;
  setStatus("Memuat kapasiti...");
  try {
    const data = await apiGet("capacity", { from, to });
    const counts = data.counts || {};
    if (Array.isArray(data.category_groups) && data.category_groups.length) {
      setCategoryGroups(data.category_groups);
    }
    const categoryCounts =
      data.category_counts && typeof data.category_counts === "object" && !Array.isArray(data.category_counts)
        ? data.category_counts
        : {};
    const effectiveMax = Number(data.max_per_category || data.max || state.maxPerDay || 3);
    state.maxPerDay = effectiveMax || state.maxPerDay || 3;
    setStatus("");
    const table = document.createElement("table");
    table.className = "min-w-full border border-slate-200 rounded-lg overflow-hidden bg-white";
    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr class="bg-slate-100 text-left text-slate-700">
        <th class="px-3 py-2 font-semibold">Tarikh</th>
        <th class="px-3 py-2 font-semibold">Bil. pemandu bercuti</th>
      </tr>
    `;
  const tbody = document.createElement("tbody");
    const filteredCategoryGroup = getFilteredCategoryGroup();
    const selectedDriver = getDriverById(driverSelect?.value);
    const selectedDriverGroup = selectedDriver ? resolveCategoryGroupId(selectedDriver.category) : "";
    const activeCategoryGroup = normalizeCategoryKey(filteredCategoryGroup || selectedDriverGroup);
    dates.forEach((isoDate) => {
      const count = Number(counts[isoDate] ?? 0);
      const recordedGroupCounts = categoryCounts[isoDate] || { ALL: count };
      const normalizedCounts = {};
      Object.entries(recordedGroupCounts).forEach(([groupId, value]) => {
        const normalizedId = normalizeCategoryKey(groupId) || groupId;
        normalizedCounts[normalizedId] = Number(value) || 0;
      });
      let relevantCount = count;
      if (activeCategoryGroup) {
        relevantCount = normalizedCounts[activeCategoryGroup] ?? 0;
      }
      if (relevantCount >= state.maxPerDay) {
        state.hasFullDay = true;
      }
      const row = document.createElement("tr");
      row.className = "odd:bg-white even:bg-slate-50";
      const dateCell = document.createElement("td");
      dateCell.className = "px-3 py-2 font-medium text-slate-700";
      dateCell.textContent = isoDate;
      const countCell = document.createElement("td");
      const statusClass = getCapacityStatusClass(relevantCount, state.maxPerDay);
      countCell.className = "px-3 py-2";
      countCell.innerHTML = `<span class="font-semibold ${statusClass}">${relevantCount}/${state.maxPerDay}</span>`;
      row.appendChild(dateCell);
      row.appendChild(countCell);
      tbody.appendChild(row);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    capacityHintContainer.appendChild(table);
  } catch (error) {
    console.error(error);
    setStatus("Gagal memuat kapasiti.");
    setCapacityMessage("Tidak dapat memaparkan kapasiti. Cuba lagi nanti.");
    toast(
      `Gagal memuat kapasiti: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const loadDrivers = async () => {
  try {
    const data = await apiGet("drivers");
    state.drivers = (data.drivers || []).map(normalizeDriver);
    state.weekendDays = data.weekend_days || data.weekendDays || [6, 0];
    if (Array.isArray(data.category_groups) && data.category_groups.length) {
      setCategoryGroups(data.category_groups);
    }
    const maxPerCategory = Number(data.max_per_category || data.max_per_day);
    if (maxPerCategory) {
      state.maxPerDay = maxPerCategory;
    }
    renderDriverOptions();
    await refreshCapacityHints();
  } catch (error) {
    console.error(error);
    toast(
      `Gagal memuat pemandu: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const submitForm = async () => {
  resetPendingForceState();
  const driverId = driverSelect?.value;
  if (!driverId) {
    toast("Sila pilih pemandu", "error", { position: "center" });
    return;
  }
  const { start, end } = state.selected;
  if (!start || !end) {
    toast("Sila pilih tarikh mula dan tamat", "error", { position: "center" });
    return;
  }

  setStatus("Sedang dihantar...");

  try {
    const response = await apiPost("apply", {
      driver_id: driverId,
      start_date: start,
      end_date: end,
    });
    if (response.ok) {
      const driver = getDriverById(driverId);
      toast(
        `Permohonan dihantar untuk ${response.applied_dates.length} hari`,
        "ok",
        { position: "center" }
      );
      await afterApplied(response.applied_dates, { driver, driverId, notification: response.notification });
      resetPendingForceState();
    } else {
      const errors = Array.isArray(response.errors) ? response.errors : [];
      const fullError = errors.find((err) => err?.reason === "full");
      if (fullError || response.reason === "full") {
        // Prioritize the error date if available, otherwise use the selected start date
        state.pendingForceStart = fullError?.date || state.selected.start || null;
        state.pendingForceDriverId = driverId;
        state.pendingForceNotification = response.notification || null;
        if (state.pendingForceStart) {
          showForceModal();
          const promptMessage =
            "Tarikh pilihan penuh. Sahkan permohonan paksa dalam tetingkap pengesahan.";
          toast(promptMessage, "error", { position: "top-right" });
          setStatus(promptMessage);
          return;
        }
        resetPendingForceState();
        const missingStartMessage =
          "Tidak dapat mengenal pasti tarikh mula untuk permohonan paksa. Sila pilih semula julat tarikh.";
        toast(missingStartMessage, "error", { position: "center" });
        setStatus(missingStartMessage);
        return;
      }
      resetPendingForceState();
      const message = response.message || "Failed to submit leave.";
      toast(
        `Gagal menghantar permohonan: ${message}`,
        "error",
        { position: "center" }
      );
      setStatus(message);
    }
  } catch (error) {
    toast(
      `Penghantaran gagal: ${error.message}`,
      "error",
      { position: "center" }
    );
    setStatus("Penghantaran gagal.");
    return;
  }

  await refreshCapacityHints();
};

const confirmForce = async () => {
  if (!state.pendingForceStart) {
    toast(
      "Tiada permohonan paksa yang belum selesai.",
      "error",
      { position: "center" }
    );
    return;
  }
  const driverId = state.pendingForceDriverId || driverSelect?.value;
  if (!driverId) {
    toast(
      "Sila pilih pemandu sebelum mengesahkan paksa.",
      "error",
      { position: "center" }
    );
    return;
  }
  const driver = getDriverById(driverId);
  try {
    const response = await apiPost("apply_force3", {
      driver_id: driverId,
      start_date: state.pendingForceStart,
    });
    if (response.ok) {
      toast(
        "Permohonan paksa 3 hari bekerja disahkan.",
        "ok",
        { position: "center" }
      );
      hideForceModal();
      const notification = response.notification || state.pendingForceNotification;
      await afterApplied(response.applied_dates, { driver, driverId, notification });
      resetPendingForceState();
      await refreshCapacityHints();
    } else {
      toast(
        `Permohonan paksa gagal: ${response.message || ""}`,
        "error",
        { position: "center" }
      );
    }
  } catch (error) {
    toast(
      `Permohonan paksa gagal: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const afterApplied = async (dates, { driver, driverId, notification } = {}) => {
  const appliedDates = Array.isArray(dates) ? dates : [];
  const approvedCount = appliedDates.length;
  setStatus(
    `Penghantaran terakhir: ${approvedCount} hari diluluskan.`
  );
  const resolvedDriver = driver || getDriverById(driverId);
  
  // Send notification with snapshot image included
  if (notification) {
    await sendLeaveNotificationWithSnapshot(notification, appliedDates, resolvedDriver);
  }
  
  await loadDrivers();
};

const handleDateRangeChange = (selectedDates) => {
  if (!selectedDates || !selectedDates.length) {
    state.selected.start = null;
    state.selected.end = null;
    setCapacityMessage("Sila pilih julat tarikh untuk melihat kapasiti.");
    return;
  }

  const startDate = selectedDates[0] || null;
  const endDate = selectedDates.length >= 2 ? selectedDates[selectedDates.length - 1] : null;

  state.selected.start = startDate ? fmt(startDate) : null;

  if (!endDate) {
    state.selected.end = null;
    setCapacityMessage("Sila pilih tarikh tamat untuk melihat kapasiti.");
    return;
  }

  state.selected.end = fmt(endDate);
  refreshCapacityHints();
};

const handleDateRangeClose = (selectedDates) => {
  if (selectedDates.length === 1) {
    handleDateRangeChange([selectedDates[0], selectedDates[0]]);
  }
};

const initializeDatePicker = () => {
  if (!dateRangeInput || typeof window.flatpickr !== "function") {
    console.warn("Flatpickr is not available.");
    return;
  }
  const localeConfig =
    window.flatpickr?.l10ns?.ms
      ? { ...window.flatpickr.l10ns.ms, rangeSeparator: " hingga " }
      : undefined;
  dateRangePicker = window.flatpickr(dateRangeInput, {
    mode: "range",
    dateFormat: "Y-m-d",
    allowInput: false,
    locale: localeConfig,
    static: true,
    onChange: handleDateRangeChange,
    onClose: handleDateRangeClose,
  });
};

// Event bindings
qs("#btnSubmit")?.addEventListener("click", submitForm);
qs("#btnCancelForce")?.addEventListener("click", () => {
  hideForceModal();
  resetPendingForceState();
});
qs("#btnConfirmForce")?.addEventListener("click", confirmForce);

// Initialize
(async () => {
  initializeDatePicker();
  await loadDrivers();
})();

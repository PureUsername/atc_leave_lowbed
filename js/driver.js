import { apiGet, apiPost, addDays, fmt, normalizeDriver, qs, toast } from "./common.js";

const state = {
  drivers: [],
  weekendDays: [6, 0],
  selected: { start: null, end: null },
  hasFullDay: false,
  pendingForceStart: null,
  pendingForceDriverId: null,
  pendingForceNotification: null,
  maxPerDay: 3,
};

const SNAPSHOT_CHAT_ID = "120363406616265454@g.us";
const driverSelect = qs("#driverSelect");
const capacityHintContainer = qs("#capacityHints");
const statusLabel = qs("#status");
const dateRangeInput = qs("#dateRange");
let dateRangePicker = null;

const bilingual = (ms, en) => `${ms} / ${en}`;
const setCapacityMessage = (ms, en) => {
  if (!capacityHintContainer) return;
  capacityHintContainer.innerHTML = `<p class="text-slate-500">${bilingual(ms, en)}</p>`;
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

const sendLeaveNotification = async (notification = {}) => {
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

  const payload = {
    chatId: SNAPSHOT_CHAT_ID,
    type: "buttons",
    body: notification.message,
    buttons,
    title: notification.title || bilingual("Status Permohonan Cuti", "Leave Request Status"),
    footer:
      notification.footer ||
      bilingual("Tekan butang untuk maklumkan keputusan.", "Tap a button to share your decision."),
    metadata,
  };
  if (mentionNumbers.length) {
    payload.mentionNumbers = mentionNumbers;
  }
  if (mentionJids.length) {
    payload.mentions = mentionJids;
  }
  try {
    await apiPost("whatsapp_send", payload);
  } catch (error) {
    console.error("Failed to send leave notification", error);
    toast(
      `${bilingual("Gagal menghantar mesej kelulusan", "Failed to send approval message")}: ${error.message}`,
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

const sendSnapshotToChat = async ({ base64, caption, month, driver }) => {
  const driverPart = sanitizeFilenamePart(driver?.driver_id || driver?.display_name || "driver");
  const filename = `calendar-${month}-${driverPart}.jpg`;
  const payload = {
    chatId: SNAPSHOT_CHAT_ID,
    base64,
    mimeType: "image/jpeg",
    filename,
    caption,
  };
  try {
    const response = await apiPost("whatsapp_send", payload);
    if (response?.ok !== false) {
      return;
    }
    throw new Error(response?.message || "Snapshot bridge returned an error.");
  } catch (error) {
    throw new Error(error?.message || "Snapshot bridge request failed.");
  }
};

const sendSnapshotsForDates = async (dates, driver) => {
  if (!driver || !Array.isArray(dates) || !dates.length) {
    return;
  }
  const months = uniqueMonthsFromDates(dates);
  if (!months.length) {
    return;
  }
  const caption = buildSnapshotCaption(driver, dates);
  let notifiedSuccess = false;
  for (const month of months) {
    try {
      const base64 = await fetchMonthSnapshotAsBase64(month);
      await sendSnapshotToChat({ base64, caption, month, driver });
      if (!notifiedSuccess) {
        toast(
          bilingual("Snapshot kalendar dihantar.", "Calendar snapshot sent."),
          "ok",
          { position: "center" }
        );
        notifiedSuccess = true;
      }
    } catch (error) {
      console.error("Failed to send calendar snapshot", error);
      toast(
        `${bilingual("Gagal menghantar snapshot kalendar", "Failed to send calendar snapshot")}: ${error.message}`,
        "error",
        { position: "center" }
      );
    }
  }
};

const renderDriverOptions = () => {
  if (!driverSelect) return;
  const previousValue = driverSelect.value;
  driverSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = bilingual("Pilih nama", "Select your name");
  placeholder.disabled = true;
  driverSelect.appendChild(placeholder);
  let restoredSelection = false;
  state.drivers
    .filter((driver) => driver.active !== false)
    .forEach((driver) => {
      const opt = document.createElement("option");
      opt.value = driver.driver_id || "";
      const name = driver.display_name || driver.driver_id || "Unnamed Driver";
      opt.textContent = `${name}${driver.category ? ` (${driver.category})` : ""}`;
      driverSelect.appendChild(opt);
      if (!restoredSelection && opt.value && opt.value === previousValue) {
        restoredSelection = true;
      }
    });
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

const refreshCapacityHints = async () => {
  if (!capacityHintContainer) {
    return;
  }
  const dates = collectSelectedDates();
  capacityHintContainer.innerHTML = "";
  if (!dates.length) {
    state.hasFullDay = false;
    setStatus("");
    setCapacityMessage(
      "Sila pilih julat tarikh untuk melihat kapasiti.",
      "Select a date range to view capacity."
    );
    return;
  }
  const from = dates[0];
  const to = dates[dates.length - 1];
  state.hasFullDay = false;
  setStatus(bilingual("Memuat kapasiti...", "Loading capacity..."));
  try {
    const data = await apiGet("capacity", { from, to });
    const counts = data.counts || {};
    state.maxPerDay = data.max || state.maxPerDay || 3;
    setStatus("");
    const table = document.createElement("table");
    table.className = "min-w-full border border-slate-200 rounded-lg overflow-hidden bg-white";
    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr class="bg-slate-100 text-left text-slate-700">
        <th class="px-3 py-2 font-semibold">Tarikh / Date</th>
        <th class="px-3 py-2 font-semibold">Bil. pemandu bercuti (tarikh ini) / Employees on Leave (This Date)</th>
      </tr>
    `;
    const tbody = document.createElement("tbody");
    dates.forEach((isoDate) => {
      const count = counts[isoDate] ?? 0;
      if (count >= state.maxPerDay) {
        state.hasFullDay = true;
      }
      const row = document.createElement("tr");
      row.className = "odd:bg-white even:bg-slate-50";
      const dateCell = document.createElement("td");
      dateCell.className = "px-3 py-2 font-medium text-slate-700";
      dateCell.textContent = isoDate;
      const countCell = document.createElement("td");
      const statusClass =
        count >= state.maxPerDay ? "text-red-600" : count === state.maxPerDay - 1 ? "text-amber-600" : "text-emerald-600";
      countCell.className = "px-3 py-2";
      countCell.innerHTML = `<span class="font-semibold ${statusClass}">${count}/${state.maxPerDay}</span>`;
      row.appendChild(dateCell);
      row.appendChild(countCell);
      tbody.appendChild(row);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    capacityHintContainer.appendChild(table);
  } catch (error) {
    console.error(error);
    setStatus(bilingual("Gagal memuat kapasiti.", "Failed to load capacity."));
    setCapacityMessage(
      "Tidak dapat memaparkan kapasiti. Cuba lagi nanti.",
      "Unable to display capacity. Please try again later."
    );
    toast(
      `${bilingual("Gagal memuat kapasiti", "Failed to load capacity")}: ${error.message}`,
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
    if (data.max_per_day) {
      state.maxPerDay = data.max_per_day;
    }
    renderDriverOptions();
    await refreshCapacityHints();
  } catch (error) {
    console.error(error);
    toast(
      `${bilingual("Gagal memuat pemandu", "Failed to load drivers")}: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const submitForm = async () => {
  resetPendingForceState();
  const driverId = driverSelect?.value;
  if (!driverId) {
    toast(bilingual("Sila pilih pemandu", "Select a driver"), "error", { position: "center" });
    return;
  }
  const { start, end } = state.selected;
  if (!start || !end) {
    toast(bilingual("Sila pilih tarikh mula dan tamat", "Choose start & end"), "error", { position: "center" });
    return;
  }

  setStatus(bilingual("Sedang dihantar...", "Submitting..."));

  try {
    const response = await apiPost("apply", {
      driver_id: driverId,
      start_date: start,
      end_date: end,
    });
    if (response.ok) {
      const driver = getDriverById(driverId);
      toast(
        `Permohonan dihantar untuk ${response.applied_dates.length} hari / Applied for ${response.applied_dates.length} day(s)`,
        "ok",
        { position: "center" }
      );
      await afterApplied(response.applied_dates, { driver, driverId, notification: response.notification });
      resetPendingForceState();
    } else {
      const errors = Array.isArray(response.errors) ? response.errors : [];
      const hasFullError = errors.some((err) => err?.reason === "full");
      if (hasFullError && state.selected.start) {
        state.pendingForceStart = state.selected.start;
        state.pendingForceDriverId = driverId;
        state.pendingForceNotification = response.notification || null;
        qs("#forceModal")?.classList.remove("hidden");
        const promptMessage = bilingual(
          "Tarikh pilihan penuh. Sahkan permohonan paksa dalam tetingkap pengesahan.",
          "Selected dates are full. Confirm the forced request in the dialog."
        );
        toast(promptMessage, "error", { position: "top-right" });
        setStatus(promptMessage);
        return;
      }
      resetPendingForceState();
      const message = response.message || "Failed to submit leave.";
      toast(
        `${bilingual("Gagal menghantar permohonan", "Failed to submit leave")}: ${message}`,
        "error",
        { position: "center" }
      );
      setStatus(message);
    }
  } catch (error) {
    toast(
      `${bilingual("Penghantaran gagal", "Submit failed")}: ${error.message}`,
      "error",
      { position: "center" }
    );
    setStatus(bilingual("Penghantaran gagal.", "Submit failed."));
    return;
  }

  await refreshCapacityHints();
};

const confirmForce = async () => {
  if (!state.pendingForceStart) {
    toast(
      bilingual("Tiada permohonan paksa yang belum selesai.", "No force request pending."),
      "error",
      { position: "center" }
    );
    return;
  }
  const driverId = state.pendingForceDriverId || driverSelect?.value;
  if (!driverId) {
    toast(
      bilingual("Sila pilih pemandu sebelum mengesahkan paksa.", "Select a driver before confirming force."),
      "error",
      { position: "center" }
    );
    return;
  }
  const driver = getDriverById(driverId);
  
  // Hide modal immediately
  qs("#forceModal")?.classList.add("hidden");
  setStatus(bilingual("Sedang dihantar...", "Submitting..."));
  
  try {
    const response = await apiPost("apply_force3", {
      driver_id: driverId,
      start_date: state.pendingForceStart,
    });
    if (response.ok) {
      toast(
        bilingual("Permohonan paksa 3 hari bekerja disahkan.", "Forced 3 working days confirmed."),
        "ok",
        { position: "center" }
      );
      const notification = response.notification || state.pendingForceNotification;
      await afterApplied(response.applied_dates, { driver, driverId, notification });
      resetPendingForceState();
      await refreshCapacityHints();
    } else {
      toast(
        `${bilingual("Permohonan paksa gagal", "Force request failed")}: ${response.message || ""}`,
        "error",
        { position: "center" }
      );
      setStatus(response.message || bilingual("Permohonan paksa gagal.", "Force request failed."));
    }
  } catch (error) {
    toast(
      `${bilingual("Permohonan paksa gagal", "Force request failed")}: ${error.message}`,
      "error",
      { position: "center" }
    );
    setStatus(bilingual("Permohonan paksa gagal.", "Force request failed."));
  }
};

const afterApplied = async (dates, { driver, driverId, notification } = {}) => {
  const appliedDates = Array.isArray(dates) ? dates : [];
  const approvedCount = appliedDates.length;
  setStatus(
    `Penghantaran terakhir: ${approvedCount} hari diluluskan. / Last submission: ${approvedCount} day(s) approved.`
  );
  const resolvedDriver = driver || getDriverById(driverId);
  if (appliedDates.length && resolvedDriver) {
    try {
      await sendSnapshotsForDates(appliedDates, resolvedDriver);
    } catch (error) {
      console.error("Snapshot sending failed", error);
    }
  }
  if (notification) {
    await sendLeaveNotification(notification);
  }
  await loadDrivers();
};

const handleDateRangeChange = (selectedDates) => {
  if (!selectedDates || !selectedDates.length) {
    state.selected.start = null;
    state.selected.end = null;
    setCapacityMessage(
      "Sila pilih julat tarikh untuk melihat kapasiti.",
      "Select a date range to view capacity."
    );
    return;
  }

  const startDate = selectedDates[0] || null;
  const endDate = selectedDates.length >= 2 ? selectedDates[selectedDates.length - 1] : null;

  state.selected.start = startDate ? fmt(startDate) : null;

  if (!endDate) {
    state.selected.end = null;
    setCapacityMessage(
      "Sila pilih tarikh tamat untuk melihat kapasiti.",
      "Select an end date to view capacity."
    );
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
      ? { ...window.flatpickr.l10ns.ms, rangeSeparator: " hingga / to " }
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
  qs("#forceModal")?.classList.add("hidden");
  resetPendingForceState();
});
qs("#btnConfirmForce")?.addEventListener("click", confirmForce);

// Initialize
(async () => {
  initializeDatePicker();
  await loadDrivers();
})();

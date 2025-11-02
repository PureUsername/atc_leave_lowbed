import { apiGet, apiPost, addDays, fmt, normalizeDriver, qs, toast } from "./common.js";

const state = {
  drivers: [],
  weekendDays: [6, 0],
  selected: { start: null, end: null },
  hasFullDay: false,
  pendingForceStart: null,
  maxPerDay: 3,
};

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
      toast(
        `Permohonan dihantar untuk ${response.applied_dates.length} hari / Applied for ${response.applied_dates.length} day(s)`,
        "ok",
        { position: "center" }
      );
      await afterApplied(response.applied_dates);
    } else {
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
  const driverId = driverSelect?.value;
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
      qs("#forceModal")?.classList.add("hidden");
      state.pendingForceStart = null;
      await afterApplied(response.applied_dates);
      await refreshCapacityHints();
    } else {
      toast(
        `${bilingual("Permohonan paksa gagal", "Force request failed")}: ${response.message || ""}`,
        "error",
        { position: "center" }
      );
    }
  } catch (error) {
    toast(
      `${bilingual("Permohonan paksa gagal", "Force request failed")}: ${error.message}`,
      "error",
      { position: "center" }
    );
  }
};

const afterApplied = async (dates) => {
  setStatus(
    `Penghantaran terakhir: ${dates.length} hari diluluskan. / Last submission: ${dates.length} day(s) approved.`
  );
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
  state.pendingForceStart = null;
});
qs("#btnConfirmForce")?.addEventListener("click", confirmForce);

// Initialize
(async () => {
  initializeDatePicker();
  await loadDrivers();
})();

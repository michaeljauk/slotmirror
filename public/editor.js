// Calendar editor without a reload per click. A choice changes its card, the pills and the
// overview at once; the bar at the bottom saves every change of the page in one request.
// Without this script every button is a plain form submit, so the editor also works without it.

// A copy button copies the value of the field it names; without the script, the field is selectable.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  const field = button && document.getElementById(button.dataset.copy);
  if (!field) return;
  field.select();
  try {
    await navigator.clipboard.writeText(field.value);
    button.textContent = button.dataset.copied;
  } catch {
    // The field stays selected for a manual copy.
  }
});

// Account settings: a zone field without a stored zone gets the browser's zone. Without the
// script it keeps the server's.
for (const field of document.querySelectorAll("input[name=workTimeZone][data-browser-zone]")) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone) field.value = zone;
}
// "Until midnight" stands for 24:00, which a time field cannot hold; it disables the end field.
// The server renders the field enabled, so that it works without the script.
for (const box of document.querySelectorAll("input[name=workUntilMidnight]:checked")) {
  const end = box.form?.elements.workEnd;
  if (end) end.disabled = true;
}
document.addEventListener("change", (event) => {
  if (event.target.name !== "workUntilMidnight") return;
  const end = event.target.form?.elements.workEnd;
  if (end) end.disabled = event.target.checked;
});

(() => {
  document.documentElement.classList.add("js");
  const bar = document.getElementById("page-bar");
  if (!bar) return;
  const short = JSON.parse(bar.dataset.short);
  /** Saved choice per direction "from>to", read from the page. */
  const original = new Map();
  /** Unsaved choice per direction. */
  const pending = new Map();
  /** Overview labels as the server rendered them, to restore on discard. */
  const cellLabels = new Map();

  for (const group of document.querySelectorAll(".choices[data-to]")) {
    const from = group.closest("details.source").dataset.source;
    original.set(`${from}>${group.dataset.to}`, group.querySelector(".choice.on")?.value ?? "off");
  }
  for (const cell of document.querySelectorAll(".matrix .cell[data-key] small")) {
    cellLabels.set(cell.closest(".cell").dataset.key, cell.textContent);
  }

  /** Show a choice everywhere it appears: buttons, example, pill and overview cell. */
  function show(key, choice) {
    const [from, to] = key.split(">");
    const card = document.getElementById(`src-${from}`);
    const group = card?.querySelector(`.choices[data-to="${to}"]`);
    if (group) {
      for (const button of group.querySelectorAll(".choice")) {
        button.classList.toggle("on", button.value === choice);
        button.setAttribute("aria-pressed", String(button.value === choice));
      }
      for (const example of group.closest(".dest").querySelectorAll("[data-example]")) {
        example.hidden = example.dataset.example !== choice;
      }
    }
    const changed = choice !== original.get(key);
    // Collapsed pills cannot show a single change; show them one by one from now on.
    for (const pills of document.querySelectorAll(
      `.pills.collapsed:has(.pill[data-key="${key}"])`,
    )) {
      pills.classList.remove("collapsed");
    }
    for (const pill of document.querySelectorAll(`.pill[data-key="${key}"]`)) {
      pill.querySelector("b").textContent = short[choice];
      pill.classList.toggle("pending", changed);
    }
    const cell = document.querySelector(`.matrix .cell[data-key="${key}"]`);
    if (cell) {
      cell.className = `cell level-${choice}${changed ? " pending" : ""}`;
      const link = cell.querySelector("a");
      link.firstChild.textContent = short[choice];
      link.querySelector("small").textContent = changed ? bar.dataset.changed : cellLabels.get(key);
    }
    if (card) {
      const dirty = [...pending.keys()].some((pendingKey) => pendingKey.startsWith(`${from}>`));
      card.classList.toggle("dirty", dirty);
    }
  }

  function refreshBar(text) {
    const count = pending.size;
    bar.hidden = count === 0 && !text;
    bar.querySelector(".edit-count").textContent =
      text ?? (count === 1 ? bar.dataset.one : bar.dataset.many.replace("{n}", String(count)));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest(".choices[data-to] .choice");
    if (!button || button.disabled) return;
    event.preventDefault();
    const group = button.closest(".choices");
    const from = group.closest("details.source").dataset.source;
    const key = `${from}>${group.dataset.to}`;
    if (button.value === original.get(key)) pending.delete(key);
    else pending.set(key, button.value);
    show(key, button.value);
    refreshBar();
  });

  // Source calendar chips toggle locally; each changed calendar counts as one change.
  const savedSources = new Map();
  for (const chip of document.querySelectorAll(".cal-chip[data-calendar]")) {
    savedSources.set(chip.dataset.calendar, !chip.classList.contains("out"));
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      const on = chip.classList.toggle("out") === false;
      chip.setAttribute("aria-pressed", String(on));
      const key = `calendar:${chip.dataset.calendar}`;
      if (on === savedSources.get(chip.dataset.calendar)) pending.delete(key);
      else pending.set(key, on ? "1" : "0");
      chip.classList.toggle("pending", pending.has(key));
      refreshBar();
    });
  }

  /** A form value as trimmed text; a missing field is empty. */
  const asText = (value) => (typeof value === "string" ? value.trim() : "");

  // The details of a direction, its colour and its working-hours checkbox, count as one change
  // while they differ from the saved ones. Their fields sit in the row and name the form.
  const detailsOf = (form) => {
    const data = new FormData(form);
    return {
      blockColor: asText(data.get("blockColor")),
      workHours: data.has("workHoursShown") ? (data.has("workHours") ? "1" : "0") : null,
    };
  };
  const savedDetails = new Map();
  for (const form of document.querySelectorAll("form.dest-details[data-key]")) {
    const key = `details:${form.dataset.key}`;
    const row = form.closest(".dest");
    savedDetails.set(key, detailsOf(form));
    // Show the chosen Google colour on the swatch and in the examples of the direction.
    const showColor = () => {
      const input = [...form.elements].find((el) => el.name === "blockColor" && el.checked);
      if (!input) return;
      const fill = input.nextElementSibling?.dataset.fill;
      const swatch = row.querySelector(".swatch");
      const dot = swatch?.querySelector(".swatch-dot");
      if (dot) {
        dot.classList.toggle("none", !fill);
        dot.style.background = fill ?? "";
        swatch.querySelector(".swatch-name").textContent = input.dataset.name;
      }
      for (const example of row.querySelectorAll("[data-example] .ev")) {
        if (example.classList.contains("none")) continue;
        example.classList.toggle("filled", Boolean(fill));
        if (fill) example.style.setProperty("--fill", fill);
        else example.style.removeProperty("--fill");
      }
    };
    const onChange = (event) => {
      if (event && event.target !== row && event.target.form !== form) return;
      showColor();
      if (event?.target.name === "blockColor" && event.type === "change") {
        row.querySelector(".swatch")?.removeAttribute("open");
      }
      const value = detailsOf(form);
      const saved = savedDetails.get(key);
      if (value.blockColor === saved.blockColor && value.workHours === saved.workHours) {
        pending.delete(key);
      } else pending.set(key, value);
      row.classList.toggle("pending", pending.has(key));
      refreshBar();
    };
    row.addEventListener("change", onChange);
    row.addEventListener("input", onChange);
    // Enter in the category field saves every change of the page, as the bar does.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onChange();
      if (pending.size > 0) void save();
    });
  }
  // A click outside an open palette closes it.
  document.addEventListener("click", (event) => {
    for (const swatch of document.querySelectorAll("details.swatch[open]")) {
      if (!swatch.contains(event.target)) swatch.removeAttribute("open");
    }
  });

  // The buffer of a source counts as one change while it differs from the saved one.
  const bufferOf = (form) => {
    const data = new FormData(form);
    const minutes = (name) => asText(data.get(name));
    return `${minutes("bufferBefore")},${minutes("bufferAfter")}`;
  };
  const savedBuffers = new Map();
  for (const form of document.querySelectorAll("form.source-buffer[data-source]")) {
    const key = `buffer:${form.dataset.source}`;
    savedBuffers.set(key, bufferOf(form));
    const onChange = () => {
      const value = bufferOf(form);
      if (value === savedBuffers.get(key)) pending.delete(key);
      else pending.set(key, value);
      form.classList.toggle("pending", pending.has(key));
      refreshBar();
    };
    form.addEventListener("change", onChange);
    form.addEventListener("input", onChange);
    // Enter in a buffer field saves every change of the page, as the bar does.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onChange();
      if (pending.size > 0) void save();
    });
  }

  // The settings form counts as one change while it differs from the saved settings.
  const settings = document.getElementById("settings");
  const readSettings = () => new URLSearchParams(new FormData(settings)).toString();
  const savedSettings = settings ? readSettings() : "";
  const onSettings = () => {
    if (readSettings() === savedSettings) pending.delete("settings");
    else pending.set("settings", readSettings());
    refreshBar();
  };
  settings?.addEventListener("change", onSettings);
  settings?.addEventListener("input", onSettings);
  // Enter in a settings field would post the settings alone and lose every other change.
  settings?.addEventListener("submit", (event) => {
    event.preventDefault();
    onSettings();
    if (pending.size > 0) void save();
  });

  bar.querySelector(".edit-cancel").addEventListener("click", () => {
    const keys = [...pending.keys()];
    pending.clear();
    for (const key of keys) {
      if (key.startsWith("details:")) {
        const form = document.querySelector(`form.dest-details[data-key="${key.slice(8)}"]`);
        form?.reset();
        form?.closest(".dest")?.classList.remove("pending");
        // Reset fires no change event; this one restores the swatch and the example fill.
        form?.closest(".dest")?.dispatchEvent(new Event("change"));
      } else if (key.startsWith("calendar:")) {
        const chip = document.querySelector(`.cal-chip[data-calendar="${key.slice(9)}"]`);
        chip?.classList.toggle("out", !savedSources.get(key.slice(9)));
        chip?.setAttribute("aria-pressed", String(savedSources.get(key.slice(9))));
        chip?.classList.remove("pending");
      } else if (key.startsWith("buffer:")) {
        const form = document.querySelector(`form.source-buffer[data-source="${key.slice(7)}"]`);
        form?.reset();
        form?.classList.remove("pending");
      } else if (key !== "settings") show(key, original.get(key));
    }
    settings?.reset();
    refreshBar();
  });

  bar.querySelector(".edit-save").addEventListener("click", () => void save());

  /** Save every change of the page in one request. The server applies all of it or nothing. */
  async function save() {
    if (bar.classList.contains("saving")) return;
    // A changed buffer outside its limits, or text in a number field, stops the save with the
    // browser's own message; the server would refuse the whole save.
    const invalid = [...document.querySelectorAll("form.source-buffer")]
      .filter((form) => pending.has(`buffer:${form.dataset.source}`))
      .flatMap((form) => [...form.querySelectorAll("input[type=number]")])
      .find((input) => !input.checkValidity());
    if (invalid) {
      invalid.closest("details.source")?.setAttribute("open", "");
      invalid.closest("details.buffer-edit")?.setAttribute("open", "");
      invalid.reportValidity();
      return;
    }
    const body = new URLSearchParams();
    for (const [key, choice] of pending) {
      if (key === "settings") continue;
      if (key.startsWith("calendar:")) {
        body.append(`calendar.${key.slice(9)}`, choice);
        continue;
      }
      if (key.startsWith("details:")) {
        const [from, to] = key.slice(8).split(">");
        const saved = savedDetails.get(key);
        if (choice.blockColor !== saved.blockColor) {
          body.append(`blockColor.${from}.${to}`, choice.blockColor);
        }
        if (choice.workHours !== saved.workHours && choice.workHours !== null) {
          body.append(`workHours.${from}.${to}`, choice.workHours);
        }
        continue;
      }
      if (key.startsWith("buffer:")) {
        const [before, after] = choice.split(",");
        body.append(`bufferBefore.${key.slice(7)}`, before);
        body.append(`bufferAfter.${key.slice(7)}`, after);
        continue;
      }
      const [from, to] = key.split(">");
      body.append(`choice.${from}.${to}`, choice);
    }
    if (pending.has("settings")) {
      body.append("settings", "1");
      for (const [name, value] of new FormData(settings)) body.append(`settings.${name}`, value);
    }
    bar.classList.add("saving");
    try {
      const response = await fetch("/rules/choices", {
        method: "POST",
        body,
        headers: { "x-fragment": "1" },
      });
      // A refused save names its reason; nothing of it was written.
      if (response.status === 400) {
        bar.classList.remove("saving");
        refreshBar((await response.text()) || bar.dataset.failed);
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      // Reload once, with the changed cards open, so that every label comes from the server.
      const open = [
        ...new Set(
          [...pending.keys()]
            .filter((key) => key !== "settings" && !key.startsWith("calendar:"))
            .map((key) => key.replace(/^\w+:/, "").split(">")[0]),
        ),
      ];
      pending.clear();
      location.assign(`/rules?open=${open.map(encodeURIComponent).join(",")}`);
    } catch {
      bar.classList.remove("saving");
      refreshBar(bar.dataset.failed);
    }
  }

  // Leaving the page with unsaved changes asks first.
  window.addEventListener("beforeunload", (event) => {
    if (pending.size > 0) event.preventDefault();
  });

  // A cell in the overview opens its source card instead of loading the page again.
  document.getElementById("overview")?.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-open]");
    const card = link && document.getElementById(`src-${link.dataset.open}`);
    if (!card) return;
    event.preventDefault();
    card.open = true;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // The check with real events shows its result next to its button.
  for (const form of document.querySelectorAll("form.preview-form")) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const result = form.querySelector(".preview-result");
      result.classList.remove("error");
      result.textContent = form.dataset.loading;
      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          headers: { "x-fragment": "1" },
        });
        // The server words its own results and refusals (400). Anything else, such as a 404 or a
        // 500 page, gets the generic text.
        const plain = response.headers.get("content-type")?.startsWith("text/plain");
        const worded = plain && (response.ok || response.status === 400);
        result.textContent = worded ? await response.text() : form.dataset.failed;
        result.classList.toggle("error", !response.ok);
      } catch {
        result.textContent = form.dataset.failed;
        result.classList.add("error");
      }
    });
  }
})();

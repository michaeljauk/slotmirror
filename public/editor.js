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

  // The block colour of a direction counts as one change while it differs from the saved one.
  const blockColorOf = (form) => new FormData(form).get("blockColor") ?? "";
  const savedBlockColors = new Map();
  for (const form of document.querySelectorAll("form.block-color[data-key]")) {
    const key = `blockColor:${form.dataset.key}`;
    savedBlockColors.set(key, blockColorOf(form));
    // Fill the examples of the direction with the chosen Google colour, or clear the fill.
    const showFill = () => {
      const dot = form.querySelector("input[name=blockColor]:checked + .color-dot");
      const fill = dot?.dataset.fill;
      for (const example of form.closest(".dest").querySelectorAll("[data-example] .ev")) {
        if (example.classList.contains("none")) continue;
        example.classList.toggle("filled", Boolean(fill));
        if (fill) example.style.setProperty("--fill", fill);
        else example.style.removeProperty("--fill");
      }
    };
    const onChange = () => {
      showFill();
      const value = blockColorOf(form);
      if (value.trim() === savedBlockColors.get(key).trim()) pending.delete(key);
      else pending.set(key, value);
      form.classList.toggle("pending", pending.has(key));
      refreshBar();
    };
    form.addEventListener("change", onChange);
    form.addEventListener("input", onChange);
    // Enter in the category field saves every change of the page, as the bar does.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onChange();
      if (pending.size > 0) void save();
    });
  }

  // The buffers of a direction count as one change while they differ from the saved ones.
  const bufferOf = (form) => {
    const data = new FormData(form);
    const minutes = (name) => String(Number(data.get(name) || 0));
    return `${minutes("bufferBefore")},${minutes("bufferAfter")}`;
  };
  const savedBuffers = new Map();
  for (const form of document.querySelectorAll("form.block-buffer[data-key]")) {
    const key = `buffer:${form.dataset.key}`;
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
      if (key.startsWith("calendar:")) {
        const chip = document.querySelector(`.cal-chip[data-calendar="${key.slice(9)}"]`);
        chip?.classList.toggle("out", !savedSources.get(key.slice(9)));
        chip?.setAttribute("aria-pressed", String(savedSources.get(key.slice(9))));
        chip?.classList.remove("pending");
      } else if (key.startsWith("blockColor:")) {
        const form = document.querySelector(`form.block-color[data-key="${key.slice(11)}"]`);
        form?.reset();
        form?.classList.remove("pending");
        // Reset fires no change event; this one restores the example fill.
        form?.dispatchEvent(new Event("change"));
      } else if (key.startsWith("buffer:")) {
        const form = document.querySelector(`form.block-buffer[data-key="${key.slice(7)}"]`);
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
    // A buffer outside its limits, or text in a number field, stops the save with the browser's
    // own message; the server would refuse the whole save.
    const invalid = [...document.querySelectorAll("form.block-buffer input")].find(
      (input) => !input.checkValidity(),
    );
    if (invalid) {
      invalid.closest("details")?.setAttribute("open", "");
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
      if (key.startsWith("blockColor:")) {
        const [from, to] = key.slice(11).split(">");
        body.append(`blockColor.${from}.${to}`, choice);
        continue;
      }
      if (key.startsWith("buffer:")) {
        const [from, to] = key.slice(7).split(">");
        const [before, after] = choice.split(",");
        body.append(`bufferBefore.${from}.${to}`, before);
        body.append(`bufferAfter.${from}.${to}`, after);
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
            .filter((key) => key.includes(">"))
            .map((key) => key.replace(/^(blockColor|buffer):/, "").split(">")[0]),
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

// Calendar editor without a reload per click. A choice changes its card, the pills and the
// overview at once; the bar at the bottom saves every change of the page in one request.
// Without this script every button is a plain form submit, so the editor also works without it.
(() => {
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
      }
      for (const example of group.closest(".dest").querySelectorAll("[data-example]")) {
        example.hidden = example.dataset.example !== choice;
      }
    }
    const changed = choice !== original.get(key);
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

  bar.querySelector(".edit-cancel").addEventListener("click", () => {
    const keys = [...pending.keys()];
    pending.clear();
    for (const key of keys) show(key, original.get(key));
    refreshBar();
  });

  bar.querySelector(".edit-save").addEventListener("click", async () => {
    const body = new URLSearchParams();
    for (const [key, choice] of pending) {
      const [from, to] = key.split(">");
      body.append(`choice.${from}.${to}`, choice);
    }
    bar.classList.add("saving");
    try {
      const response = await fetch("/rules/choices", {
        method: "POST",
        body,
        headers: { "x-fragment": "1" },
      });
      if (!response.ok) throw new Error(String(response.status));
      // Reload once, with the changed cards open, so that every label comes from the server.
      const open = [...new Set([...pending.keys()].map((key) => key.split(">")[0]))];
      pending.clear();
      location.assign(`/rules?open=${open.map(encodeURIComponent).join(",")}`);
    } catch {
      bar.classList.remove("saving");
      refreshBar(bar.dataset.failed);
    }
  });

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
      const response = await fetch(form.action, { method: "POST", headers: { "x-fragment": "1" } });
      result.textContent = await response.text();
      result.classList.toggle("error", !response.ok);
    });
  }
})();

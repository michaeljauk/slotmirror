// Calendar editor without page reloads. A choice changes its card at once; one save sends all
// changes of the card, and the server answers with the updated card. Without this script every
// button is a plain form submit, so the editor also works without JavaScript.
(() => {
  /** Send a form or fields with the fragment header and return the response. */
  function post(url, body) {
    return fetch(url, { method: "POST", body, headers: { "x-fragment": "1" } });
  }

  /** Replace a card with the server's version and set it up again. */
  async function replaceCard(card, response) {
    const html = await response.text();
    const next = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
    if (!next) return;
    card.replaceWith(next);
    setup(next);
  }

  function setup(card) {
    const bar = card.querySelector(".edit-bar");
    const original = new Map();
    const pending = new Map();
    const groups = card.querySelectorAll(".choices[data-to]");
    for (const group of groups) {
      original.set(group.dataset.to, group.querySelector(".choice.on")?.value ?? "off");
    }

    function show(group, choice) {
      for (const button of group.querySelectorAll(".choice")) {
        button.classList.toggle("on", button.value === choice);
      }
      for (const example of group.closest(".dest").querySelectorAll("[data-example]")) {
        example.hidden = example.dataset.example !== choice;
      }
    }

    function refreshBar(text) {
      const count = pending.size;
      bar.hidden = count === 0 && !text;
      card.classList.toggle("dirty", count > 0);
      bar.querySelector(".edit-count").textContent =
        text ?? (count === 1 ? bar.dataset.one : bar.dataset.many.replace("{n}", String(count)));
    }

    for (const group of groups) {
      group.addEventListener("click", (event) => {
        const button = event.target.closest(".choice");
        if (!button || button.disabled) return;
        event.preventDefault();
        const to = group.dataset.to;
        if (button.value === original.get(to)) pending.delete(to);
        else pending.set(to, button.value);
        show(group, button.value);
        refreshBar();
      });
    }

    bar.querySelector(".edit-cancel").addEventListener("click", () => {
      for (const group of groups) show(group, original.get(group.dataset.to));
      pending.clear();
      refreshBar();
    });

    bar.querySelector(".edit-save").addEventListener("click", async () => {
      const body = new URLSearchParams();
      for (const [to, choice] of pending) body.append(`choice.${to}`, choice);
      bar.classList.add("saving");
      try {
        const response = await post(
          `/rules/source/${encodeURIComponent(card.dataset.source)}/choices`,
          body,
        );
        if (!response.ok) throw new Error(String(response.status));
        await replaceCard(card, response);
      } catch {
        bar.classList.remove("saving");
        refreshBar(bar.dataset.failed);
      }
    });

    // Reset and "more options" answer with the updated card.
    for (const form of card.querySelectorAll("form.card-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const response = await post(form.action, new FormData(form));
        if (response.ok) await replaceCard(card, response);
      });
    }

    // The check with real events shows its result next to the button.
    for (const form of card.querySelectorAll("form.preview-form")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const result = form.querySelector(".preview-result");
        result.classList.remove("error");
        result.textContent = form.dataset.loading;
        const response = await post(form.action);
        result.textContent = await response.text();
        result.classList.toggle("error", !response.ok);
      });
    }
  }

  for (const card of document.querySelectorAll("details.source[data-source]")) setup(card);
})();

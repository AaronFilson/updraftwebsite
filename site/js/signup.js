import { postJson } from "./api.js";

// Email signup: posts to the backend, which adds the address to the Square customer directory.
for (const form of /** @type {NodeListOf<HTMLFormElement>} */ (document.querySelectorAll(".signup-form"))) {
  const input = /** @type {HTMLInputElement} */ (form.elements.namedItem("email"));
  const trap = /** @type {HTMLInputElement} */ (form.elements.namedItem("website"));
  const status = form.querySelector(".signup-status");
  const button = form.querySelector("button");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    input.value = input.value.trim();
    if (!input.checkValidity()) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = "Enter a valid email address.";
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    button.disabled = true;
    status.textContent = "Signing you up…";
    try {
      const res = await postJson("/api/subscribe", { email: input.value, website: trap.value });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.errors?.[0]);
      /** @type {HTMLElement} */ (form.querySelector(".signup-row")).hidden = true;
      status.textContent = "You're on the list. Thank you!";
    } catch (err) {
      status.textContent = err.message || "Couldn't sign you up right now. Please try again later.";
      button.disabled = false;
    }
  });
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
}

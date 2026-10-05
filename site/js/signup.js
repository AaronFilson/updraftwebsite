import { config } from "./config.js";

// Email signup: posts to the backend, which adds the address to the Square customer directory.
for (const form of document.querySelectorAll(".signup-form")) {
  const input = form.elements.email;
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
      const res = await fetch(`${config.apiBase}/api/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: input.value, website: form.elements.website.value }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.errors?.[0]);
      form.querySelector(".signup-row").hidden = true;
      status.textContent = "You're on the list. Thank you!";
    } catch (err) {
      status.textContent = err.message || "Couldn't sign you up right now. Please try again later.";
      button.disabled = false;
    }
  });
  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
}

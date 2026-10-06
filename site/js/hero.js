// Home page slideshow: crossfades to the next photo every 15 seconds and loops.
// Each photo is fetched one slide ahead and then kept (never unloaded), so only the first one
// loads with the page and nothing is downloaded twice. It pauses while scrolled out of view.
// A pause button satisfies WCAG 2.2.2; with reduced motion it starts paused.
const show = document.querySelector(".hero-show");
const INTERVAL = 15_000;

if (show) {
  const slides = [...show.querySelectorAll(".slide")];
  const button = /** @type {HTMLButtonElement} */ (show.querySelector(".hero-pause"));
  let index = 0;
  let timer = null;
  let userPaused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let inView = true;

  // Portrait slides use their own loaded photo as the blurred backdrop.
  const backdrop = (slide, img) => slide.style.setProperty("--bg", `url("${img.currentSrc || img.src}")`);
  for (const slide of show.querySelectorAll(".slide.portrait")) {
    const img = slide.querySelector("img");
    img.addEventListener("load", () => backdrop(slide, img));
    if (img.complete && img.currentSrc) backdrop(slide, img);
  }

  const load = (slide) => {
    for (const el of slide.querySelectorAll("[data-srcset]")) {
      el.srcset = el.dataset.srcset;
      delete el.dataset.srcset;
    }
    for (const el of slide.querySelectorAll("[data-src]")) {
      el.src = el.dataset.src;
      delete el.dataset.src;
    }
  };
  const next = () => slides[(index + 1) % slides.length];

  function go(n) {
    slides[index].classList.remove("is-active");
    slides[index].setAttribute("aria-hidden", "true");
    index = n % slides.length;
    load(slides[index]); // normally already loaded; covers a missed preload
    slides[index].classList.add("is-active");
    slides[index].removeAttribute("aria-hidden");
    load(next());
  }

  // Runs only when the visitor hasn't paused it and it's on screen.
  function update() {
    const run = !userPaused && inView;
    if (run && timer === null) timer = setInterval(() => go(index + 1), INTERVAL);
    if (!run && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    button.setAttribute("aria-label", userPaused ? "Play slideshow" : "Pause slideshow");
  }

  if (slides.length > 1) {
    button.hidden = false;
    button.addEventListener("click", () => {
      userPaused = !userPaused;
      update();
    });
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    }).observe(show);
    // Preload the second photo once the page itself has finished loading.
    if (document.readyState === "complete") load(next());
    else addEventListener("load", () => load(next()), { once: true });
    update();
  }
}

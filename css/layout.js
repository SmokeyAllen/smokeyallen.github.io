/**
 * layout.js — loads shared header and footer into every page
 * Add <div id="site-header"></div> and <div id="site-footer"></div>
 * to each page, then include <script src="/layout.js"></script>
 */

async function loadPartial(id, file) {
  try {
    const res  = await fetch(file);
    const html = await res.text();
    document.getElementById(id).innerHTML = html;
  } catch (e) {
    console.error('Failed to load', file, e);
  }
}

async function init() {
  await Promise.all([
    loadPartial('site-header', '/css/header.html'),
    loadPartial('site-footer', '/css/footer.html'),
  ]);

  // Dark mode — runs after header is injected so the button exists
  const toggle = document.getElementById('themeToggle');
  const body   = document.body;

  if (localStorage.getItem('theme') === 'dark' ||
      (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    body.classList.add('dark');
  }

  // Highlight the active nav link
  const links = document.querySelectorAll('.nav-links a');
  links.forEach(a => {
    if (a.getAttribute('href') === window.location.pathname ||
        window.location.pathname.endsWith(a.getAttribute('href').replace('/', ''))) {
      a.style.color = 'var(--color-text-primary)';
    }
  });

  toggle?.addEventListener('click', () => {
    body.classList.toggle('dark');
    localStorage.setItem('theme', body.classList.contains('dark') ? 'dark' : 'light');
    document.dispatchEvent(new Event('themeToggled'));
  });
}

document.addEventListener('DOMContentLoaded', init);

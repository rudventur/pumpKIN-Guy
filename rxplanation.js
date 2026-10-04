(function () {
  var EXPLAIN = {
    'btn-target': 'Sets the shot target. Free play aims anywhere; a locked target pulls shots toward that particle.',
    'btn-rain': 'Toggles molecule rain. Drops PubChem molecules into the stage so they can bond and react.'
  };
  function label(el) {
    return (el.innerText || el.getAttribute('aria-label') || el.id || 'button').replace(/\s+/g, ' ').trim();
  }
  function explain(el) {
    if (el.dataset && el.dataset.rxplanation) return el.dataset.rxplanation;
    if (el.id && EXPLAIN[el.id]) return EXPLAIN[el.id];
    var title = el.getAttribute('title');
    if (title && title !== 'Right-click for rxplanation') return title;
    return label(el) + ' — activates this control. Right-click any button to open its rxplanation.';
  }
  function menu() {
    var m = document.getElementById('rxplanation');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'rxplanation';
    m.setAttribute('role', 'dialog');
    m.innerHTML = '<div class="rx-title">rxplanation</div><div class="rx-body"></div><button type="button" class="rx-close" data-rxplanation="Closes this rxplanation panel.">close</button>';
    document.body.appendChild(m);
    m.querySelector('.rx-close').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      m.style.display = 'none';
    });
    return m;
  }
  function show(el, x, y) {
    var m = menu();
    m.querySelector('.rx-body').textContent = explain(el);
    m.style.display = 'block';
    var w = m.offsetWidth || 280;
    var h = m.offsetHeight || 120;
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
  }
  document.addEventListener('contextmenu', function (e) {
    var el = e.target.closest('button, a, [role="button"], .btn, .bb');
    if (!el) return;
    e.preventDefault();
    show(el, e.clientX, e.clientY);
  }, true);
  document.addEventListener('click', function (e) {
    var m = document.getElementById('rxplanation');
    if (!m || m.style.display !== 'block') return;
    if (!m.contains(e.target)) m.style.display = 'none';
  });
  function stamp() {
    document.querySelectorAll('button, a, [role="button"]').forEach(function (el) {
      if (!el.getAttribute('title')) el.setAttribute('title', 'Right-click for rxplanation');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', stamp);
  else stamp();
})();

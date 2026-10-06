// ═══════════════════════════════════════════════════════════════
//  panels.js — hide / show toggles for the in-game panels
//  (uses panel-toggle.js; choices are remembered on this device)
//
//  hud     the score pill: hiding it shrinks the pill to its toggle and
//          also hides the ship progress, gun slots, ability and AI readouts
//  quests  the OHM MISSIONS box folds down to its header
//  heads   the head picker folds down to "HEAD:" and its toggle
//
//  The game still shows / hides these panels itself (style.display) when
//  a world starts or the menu opens; the toggles only add the player's
//  own choice on top, through body.sf-hidden-<id>.
// ═══════════════════════════════════════════════════════════════
(function () {
  if (!window.sfPanels) return;
  const body = document.body;
  function bodyPanel(id, label, side) {
    sfPanels.register({
      id, label, side,
      read: () => !body.classList.contains('sf-hidden-' + id),
      apply: open => body.classList.toggle('sf-hidden-' + id, !open)
    });
    sfPanels.set(id, sfPanels.saved(id, true), { noSave: true });
  }
  bodyPanel('hud', 'the score and gun readouts', 'top');
  bodyPanel('heads', 'the head picker', 'bottom');
  sfPanels.register({ id: 'quests', el: '#questPanel', label: 'the OHM missions', side: 'right' });

  // SPACE fires: never leave a toggle focused, or the next press would
  // also flip the panel.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-panel-toggle]');
    if (b) setTimeout(() => b.blur(), 0);
  });
})();

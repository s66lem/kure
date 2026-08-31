/*
  Click a .staple or .tape 3 times to detach it. Staples leave a hole, tape
  doesn't. When an element loses its last fastener, it falls off screen.
*/
(function () {
  'use strict';

  function currentRotationDeg(el) {
    var t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 0;
    var m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) return 0;
    var v = m[1].split(',').map(Number);
    return Math.atan2(v[1], v[0]) * (180 / Math.PI);
  }

  function setTransform(el, rotDeg, txPx, tyPx) {
    el.style.transform = 'translate(' + txPx + 'px,' + tyPx + 'px) rotate(' + rotDeg + 'deg)';
  }

  function reflow(el) { void el.offsetWidth; }

  function longestTransitionProperty(el) {
    var cs = getComputedStyle(el);
    var props = cs.transitionProperty.split(',').map(function (s) { return s.trim(); });
    var durations = cs.transitionDuration.split(',').map(parseFloat);
    var delays = cs.transitionDelay.split(',').map(parseFloat);
    var bestProp = props[0], bestEnd = -1;
    props.forEach(function (p, i) {
      var end = (durations[i % durations.length] || 0) + (delays[i % delays.length] || 0);
      if (end > bestEnd) { bestEnd = end; bestProp = p; }
    });
    return { prop: bestProp, endMs: bestEnd * 1000 };
  }

  /*
    Runs apply(), then calls done() when the transition finishes. Timeout
    backstop in case a future CSS change stops transitionend from firing.
  */
  function finishOrAnimate(el, apply, done) {
    reflow(el);
    apply();
    var wait = longestTransitionProperty(el);
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      el.removeEventListener('transitionend', onEnd);
      done();
    }
    function onEnd(e) {
      if (e.target !== el || e.propertyName !== wait.prop) return;
      finish();
    }
    el.addEventListener('transitionend', onEnd);
    setTimeout(finish, wait.endMs + 80);
  }

  function nudgeStaple(el, rot, clicks) {
    setTransform(el, rot + clicks * 3, clicks * 2, clicks * 1.5);
  }

  function nudgeTape(el, rot, clicks) {
    setTransform(el, rot - clicks * 3, -clicks * 4, -clicks * 5);
    el.style.opacity = String(1 - clicks * 0.12);
  }

  function detachStaple(el, rot) {
    var parent = el.parentElement;
    // shown as the staple starts pulling free, not after it's gone
    var hole = document.createElement('span');
    hole.className = 'staple-hole';
    if (el.style.left) hole.style.left = (parseFloat(el.style.left) + 1.25) + 'px';
    if (el.style.right) hole.style.right = (parseFloat(el.style.right) - 1.25) + 'px';
    if (el.style.top) hole.style.top = (parseFloat(el.style.top) + 5) + 'px';
    if (el.style.bottom) hole.style.bottom = (parseFloat(el.style.bottom) - 5) + 'px';
    hole.style.transform = 'rotate(' + rot + 'deg)';
    parent.insertBefore(hole, el);

    el.classList.add('is-detaching');
    finishOrAnimate(el, function () {
      setTransform(el, rot + 200, 30, window.innerHeight * 1.4);
    }, function () {
      parent.removeChild(el);
      checkParentFall(parent);
    });
  }

  function detachTape(el, rot) {
    el.classList.add('is-detaching');
    var parent = el.parentElement;
    finishOrAnimate(el, function () {
      setTransform(el, rot - 160, -30, window.innerHeight * 1.4);
      el.style.opacity = '0';
    }, function () {
      parent.removeChild(el);
      checkParentFall(parent);
    });
  }

  function checkParentFall(parent) {
    if (!parent) return;
    if (parent.querySelector(':scope > .staple, :scope > .tape')) return;
    /*
      a holder can name another element to drop via data-falls: the mend tape
      sits on the crack but holds up the twin sheet below it (#rip-under)
    */
    var faller = parent;
    var target = parent.getAttribute('data-falls');
    if (target) {
      var named = document.getElementById(target.replace(/^#/, ''));
      if (named) faller = named;
    }
    if (faller.classList.contains('is-falling') || faller.classList.contains('is-fallen')) return;
    faller.classList.add('is-falling');
    finishOrAnimate(faller, function () {
      var rot = currentRotationDeg(faller);
      setTransform(faller, rot + 4, 0, window.innerHeight * 1.4);
      faller.style.opacity = '0';
    }, function () {
      faller.classList.add('is-fallen');
      faller.style.transform = 'none';
    });
  }

  function initFastener(el, isStaple) {
    if (el.dataset.fx) return;   // already wired
    el.dataset.fx = '1';
    var rot = currentRotationDeg(el);
    var clicks = 0;
    el.addEventListener('click', function () {
      if (clicks >= 3) return;
      clicks += 1;
      if (clicks < 3) {
        if (isStaple) nudgeStaple(el, rot, clicks);
        else nudgeTape(el, rot, clicks);
      } else if (isStaple) {
        detachStaple(el, rot);
      } else {
        detachTape(el, rot);
      }
    });
  }

  // Wire every fastener under root (default: whole document). Safe to re-call
  // for nodes added after load — the mend tape registers itself through this.
  function scan(root) {
    (root || document).querySelectorAll('.staple').forEach(function (el) { initFastener(el, true); });
    (root || document).querySelectorAll('.tape').forEach(function (el) { initFastener(el, false); });
  }

  window.KUREFastener = { scan: scan };

  document.addEventListener('DOMContentLoaded', function () { scan(); });
})();

/* ==========================================================================
   NMIMS Incubation Portal — Marketing site interactions
   No dependencies. Everything degrades safely with prefers-reduced-motion.
   ========================================================================== */

(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Sticky nav state ─────────────────────────────────────────────── */
  var nav = document.querySelector('.m-nav');
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    document.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── Mobile menu ──────────────────────────────────────────────────── */
  var burger = document.querySelector('.m-nav-burger');
  var mobileMenu = document.querySelector('.m-mobile-menu');
  if (burger && mobileMenu) {
    burger.addEventListener('click', function () {
      mobileMenu.classList.toggle('is-open');
    });
    mobileMenu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { mobileMenu.classList.remove('is-open'); });
    });
  }

  /* ── Scroll reveal ────────────────────────────────────────────────── */
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach(function (el) { el.classList.add('is-visible'); });
    } else {
      var revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });
      revealEls.forEach(function (el) { revealObserver.observe(el); });
    }
  }

  /* ── Animated counters (Impact numbers) ──────────────────────────── */
  var counters = document.querySelectorAll('[data-counter]');
  if (counters.length) {
    var animateCounter = function (el) {
      var target = parseInt(el.getAttribute('data-counter'), 10) || 0;
      var suffix = el.getAttribute('data-counter-suffix') || '';
      if (reduceMotion) { el.textContent = target + suffix; return; }
      var start = null;
      var duration = 1200;
      var step = function (ts) {
        if (!start) start = ts;
        var progress = Math.min((ts - start) / duration, 1);
        var eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(eased * target) + suffix;
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if ('IntersectionObserver' in window) {
      var counterObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            counterObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.4 });
      counters.forEach(function (el) { counterObserver.observe(el); });
    } else {
      counters.forEach(animateCounter);
    }
  }

  /* ── Ecosystem timeline: fill line + activate stages on scroll ──────── */
  var timeline = document.querySelector('.m-timeline');
  if (timeline) {
    var fill = timeline.querySelector('.m-timeline-line-fill');
    var stages = timeline.querySelectorAll('.m-stage');
    var activate = function () {
      var rect = timeline.getBoundingClientRect();
      var vh = window.innerHeight;
      var progress = (vh * 0.7 - rect.top) / rect.height;
      progress = Math.max(0, Math.min(1, progress));
      if (fill) fill.style.width = (progress * 100) + '%';
      var activeCount = Math.round(progress * stages.length);
      stages.forEach(function (stage, i) {
        stage.classList.toggle('is-active', i < activeCount);
      });
    };
    if (reduceMotion) {
      if (fill) fill.style.width = '100%';
      stages.forEach(function (s) { s.classList.add('is-active'); });
    } else {
      document.addEventListener('scroll', activate, { passive: true });
      activate();
    }
  }

  /* ── Testimonials carousel: center-card, peeking neighbours ─────────── */
  document.querySelectorAll('[data-carousel]').forEach(function (carousel) {
    var track   = carousel.querySelector('[data-carousel-track]');
    var slides  = Array.prototype.slice.call(carousel.querySelectorAll('.m-carousel-slide'));
    var prevBtn = carousel.querySelector('.m-carousel-prev');
    var nextBtn = carousel.querySelector('.m-carousel-next');
    var dotsWrap = carousel.parentElement.querySelector('[data-carousel-dots]');
    if (!track || !slides.length) return;

    var index = Math.floor(slides.length / 2); // start on a middle slide, like the reference
    var autoplayTimer = null;
    var autoplayDelay = 5500;

    // Build dots
    var dots = [];
    if (dotsWrap) {
      slides.forEach(function (_, i) {
        var dot = document.createElement('button');
        dot.className = 'm-carousel-dot';
        dot.type = 'button';
        dot.setAttribute('aria-label', 'Go to testimonial ' + (i + 1));
        dot.addEventListener('click', function () { goTo(i); restartAutoplay(); });
        dotsWrap.appendChild(dot);
        dots.push(dot);
      });
    }

    function update() {
      var viewport = carousel.querySelector('.m-carousel-viewport');
      var viewportW = viewport.offsetWidth;
      var active = slides[index];
      var offset = viewportW / 2 - (active.offsetLeft + active.offsetWidth / 2);
      track.style.transform = 'translateX(' + offset + 'px)';

      slides.forEach(function (slide, i) {
        slide.classList.toggle('is-active', i === index);
      });
      dots.forEach(function (dot, i) {
        dot.classList.toggle('is-active', i === index);
      });
    }

    function goTo(i) {
      index = (i + slides.length) % slides.length;
      update();
    }

    function next() { goTo(index + 1); }
    function prev() { goTo(index - 1); }

    function startAutoplay() {
      if (reduceMotion) return;
      stopAutoplay();
      autoplayTimer = setInterval(next, autoplayDelay);
    }
    function stopAutoplay() {
      if (autoplayTimer) clearInterval(autoplayTimer);
    }
    function restartAutoplay() { stopAutoplay(); startAutoplay(); }

    if (nextBtn) nextBtn.addEventListener('click', function () { next(); restartAutoplay(); });
    if (prevBtn) prevBtn.addEventListener('click', function () { prev(); restartAutoplay(); });
    carousel.addEventListener('mouseenter', stopAutoplay);
    carousel.addEventListener('mouseleave', startAutoplay);
    carousel.setAttribute('tabindex', '0');
    carousel.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { next(); restartAutoplay(); }
      if (e.key === 'ArrowLeft')  { prev(); restartAutoplay(); }
    });

    window.addEventListener('resize', update);
    update();
    startAutoplay();
  });

  /* ── Directory filter chips (client-side, data-category based) ──────── */
  document.querySelectorAll('[data-filter-group]').forEach(function (group) {
    var chips = group.querySelectorAll('.m-filter-chip');
    var gridSelector = group.getAttribute('data-filter-group');
    var grid = document.querySelector(gridSelector);
    if (!grid) return;
    var cards = grid.querySelectorAll('[data-category]');
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        chips.forEach(function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        var value = chip.getAttribute('data-filter-value');
        cards.forEach(function (card) {
          var show = value === 'all' || card.getAttribute('data-category') === value;
          card.style.display = show ? '' : 'none';
        });
      });
    });
  });
})();

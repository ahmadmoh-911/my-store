/*
 * The app used to be served from GitHub Pages
 * (https://ahmadmoh-911.github.io/my-store/). Since the licence server moved to
 * Render, that copy has no backend behind it: /api/* answers 404, so nobody can
 * sign in or activate there. Anyone who still opens the old link — a bookmark,
 * an installed home-screen icon, a shared message — is sent to the live server,
 * keeping the screen they were on (#/pos, #/reports…).
 *
 * A classic script (not a module) loaded first in <head>, so the redirect
 * happens before the app boots against a server that is not there. It does
 * nothing on any other host: the live server, localhost, or the Android app.
 */
(function () {
  var LIVE_ORIGIN = 'https://storehub-73p4.onrender.com';
  if (!/\.github\.io$/i.test(location.hostname)) return;
  var path = location.pathname.replace(/^\/my-store(\/|$)/i, '/');
  location.replace(LIVE_ORIGIN + path + location.search + location.hash);
})();

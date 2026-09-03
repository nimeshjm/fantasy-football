-- Makes the manual session cookie's lifetime measurable (issue #14).
--
-- Under SESSION_PROVIDER=manual the sessionid is a pasted secret: it cannot
-- re-authenticate itself, and no `expires` was captured at paste time, so the
-- only way to learn the cookie's real lifetime is to observe it. These two
-- columns turn "how long do these last?" into (failure time - first_ok_at).
--
--  * first_ok_at         -- when the CURRENT cookie first passed a health check
--  * cookie_fingerprint  -- SHA-256 prefix of the cookie, so a re-paste is
--                           detectable and first_ok_at can restart. Never the
--                           cookie itself: this repo is public and D1 is
--                           dumpable.
--
-- last_ok_at already existed but was only ever written by the password
-- provider's login path; the tick now writes it on every healthy heartbeat.

ALTER TABLE session ADD COLUMN first_ok_at TEXT;
ALTER TABLE session ADD COLUMN cookie_fingerprint TEXT;

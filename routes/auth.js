import express from 'express';
import passport from 'passport';
const router = express.Router();

router.get('/', (req, res) => {
    res.redirect('/login');
});

router.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

router.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            req.flash('error', info.message);
            return res.redirect('/login');
        }
        req.logIn(user, (err) => {
            if (err) return next(err);

            // ضبط مدة الجلسة لتبقى 100 يوم في قاعدة البيانات
            const HUNDRED_DAYS_MS = 100 * 24 * 60 * 60 * 1000;
            req.session.cookie.maxAge = HUNDRED_DAYS_MS;
            console.log(`[Auth] User ${user.username} logged in. Session set to persist for 100 days.`);
            if (user.role === 'super_admin') {
                res.redirect('/admin');
            } else if (user.role === 'sales') {
                res.redirect('/dashboard/customers');
            } else {
                res.redirect('/dashboard');
            }
        });
    })(req, res, next);
});

router.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('/login');
    });
});

export default router;

// i18n.js — shared across login.html, onboarding.html, register.html,
// app.html and cv.html. One dictionary, one engine, one switcher widget, so
// adding or fixing a translation happens in exactly one place instead of
// five.
//
// ── WHAT GETS TRANSLATED, AND WHAT NEVER DOES ───────────────────────────
// This covers the APP's own voice only: buttons, labels, instructions,
// error messages, onboarding copy, account/settings UI. It deliberately
// does NOT cover:
//   - Anything that becomes part of a generated document (a CV, an
//     application letter, a job description). Those are expected in
//     English regardless of the app's display language — see the separate
//     rule added to cv-chat.js's system prompt for why and how that's
//     enforced on the AI side.
//   - Job listings, payment/refund specifics, and the bulk of app.html's
//     deeper screens — not translated yet. Only a safe, high-visibility
//     subset (nav, account, common actions) is wired up for now; more
//     strings can be added to the dictionaries below over time without
//     touching any other file.
//
// ── STATUS OF EACH LANGUAGE (be realistic about this) ───────────────────
//   en (English)      — source of truth, always complete.
//   am (Amharic)       — best-effort machine translation, reasonably solid.
//   ti (Tigrinya)      — best-effort machine translation — get a native
//                         speaker to review before relying on it in
//                         production, especially longer sentences.
//   om (Afaan Oromoo)   — same caveat as Tigrinya.
// Any key missing from am/ti/om automatically falls back to English (see
// t() below), so a partially-translated language never shows a blank or a
// raw key to the user — it just shows English for whatever isn't done yet.
//
(function (global) {
  'use strict';

  var STORAGE_KEY = 'cvcaseLang';
  var SUPPORTED = ['en', 'am', 'ti', 'om'];
  // Short pill labels used in the switcher itself (kept very short so the
  // pill doesn't take much space in a top bar).
  var LABELS = { en: 'en', am: 'አማ', ti: 'ትግ', om: 'Oro' };
  // Full display names — used in the Account "Language" row, and sent to
  // cv-chat.js so the system prompt names the language in full rather than
  // a two-letter code.
  var NAMES = {
    en: 'English',
    am: 'አማርኛ (Amharic)',
    ti: 'ትግርኛ (Tigrinya)',
    om: 'Afaan Oromoo (Oromo)'
  };

  var STRINGS = {
    en: {
      // common
      common_continue: 'Continue',
      common_back: 'Back',
      common_goBack: '← Go back',
      common_backToHome: '← Back to home',
      common_startOver: '← Start over',
      common_resendCode: 'Resend code',
      common_tryAgain: 'Try again',
      common_maybeLater: 'Maybe later',
      common_save: 'Save',
      common_cancel: 'Cancel',
      common_confirm: 'Confirm',
      common_edit: 'Edit',
      common_processing: 'Processing…',
      common_pleaseWait: 'Please wait',
      common_saving: 'Saving…',
      common_saved: 'Saved!',
      common_goingBack: 'Going back…',
      common_skipping: 'Skipping…',
      common_loading: 'Loading…',
      common_networkError: 'Network error. Please try again.',
      common_home: 'Home',
      common_notifications: 'Notifications',
      common_account: 'Account',
      common_logout: 'Log out',
      common_logOut: 'Log Out',
      common_logoutConfirmTitle: 'Log out?',
      common_logoutConfirmBody: 'Are you sure you want to log out?',
      common_deleteAccount: 'Delete Account',
      common_deleteMyAccount: 'Delete My Account',
      common_language: 'Language',
      common_dontShowAgain: "Don't show me this again",
      common_openCvcaseBot: 'Open CVcase Bot',
      common_appLetter: 'App Letter',
      common_applicationLetterLong: 'Application Letter',
      common_pdfMerger: 'PDF Merger',
      common_findJob: 'Find Job',

      // login.html
      login_title: 'Log in or sign up',
      login_subtitle_html: "Enter <strong>the exact phone number linked to your Telegram account</strong>. We'll verify it's you over Telegram.",
      login_phoneLabel: 'Phone Number',
      login_phonePlaceholder: '09xxxxxxxx or 07xxxxxxxx',
      login_tgStepTitle: 'One more step',
      login_tgStepSubtitle: 'Open our Telegram bot and tap <strong>"Share my phone number"</strong>. Your code will appear here automatically.',
      login_openBotBtn: 'Open @cvcase_bot',
      login_tgTimeoutTitle: 'Still waiting',
      login_tgTimeoutBody: "We couldn't confirm your phone number on Telegram. This usually means the number you typed here is different from the one registered on your Telegram account, or you haven't shared it with the bot yet. Please sign in again using the same phone number your Telegram account is registered with.",
      login_otpTitle: 'Enter Code',
      login_otpSubtitle: 'Enter the 6-digit code sent to your Telegram.',
      login_verifyCode: 'Verify Code',
      login_toast_codeSent: 'Code sent to your Telegram!',
      login_toast_newCode: 'A new code was sent to your Telegram.',
      login_toast_rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
      login_toast_incorrectCode: 'Incorrect code. Please try again.',
      login_toast_couldNotResend: 'Could not resend code.',
      login_toast_enter6digit: 'Please enter the 6-digit code',
      login_toast_sessionExpired: 'Session expired. Please start over.',
      login_toast_accountDeleted: 'Your account was deleted. Enter a phone number to create a new one.',
      login_toast_sessionExpiredElsewhere: 'You were signed out because you logged in elsewhere. Please sign in again.',
      login_load_verifying: 'Verifying code…',
      login_load_resending: 'Resending code…',
      login_load_signingIn: 'Signing you in…',

      // onboarding.html
      ob_step0_title: "What's your full name?",
      ob_step0_desc: 'This appears on your application letters and CV merges.',
      ob_fullName_placeholder: 'e.g. Abebe Kebede',
      ob_fullName_error: 'Please enter your full name.',
      ob_step1_title: 'Phone number for applications',
      ob_step1_desc: 'This is the number shown on your letters and CV — it can be different from the number you registered with.',
      ob_appPhone_placeholder: 'e.g. 0912345678',
      ob_appPhone_hint: "We'll pre-fill this with your registration number, but feel free to change it.",
      ob_appPhone_error: 'Please enter a valid phone number.',
      ob_step2_title: "What's your email?",
      ob_step2_desc: 'Used for application letters and account notifications.',
      ob_email_placeholder: 'e.g. abebe@email.com',
      ob_email_error: 'Please enter a valid email address.',
      ob_step3_title: 'Your current address',
      ob_step3_desc_html: 'Shown on your letters and CV. Example: <em>Addis Ababa, Ethiopia</em>.',
      ob_address_placeholder: 'e.g. Addis Ababa, Ethiopia',
      ob_address_hint: "Tip: we recommend a large Ethiopian city (e.g. Addis Ababa, Adama, Bahir Dar, Hawassa) — even if you're not there, you're expected to relocate if invited for a written exam or interview.",
      ob_address_error: 'Please enter your address.',
      ob_step4_title: "You're all set!",
      ob_step4_desc: 'Your profile is saved. You can edit any of this anytime from your profile page in the app.',
      ob_goToApp: 'Go to CVcase',
      ob_settingUpAccount: 'Setting up your account…',

      // app.html — nav / account (safe, high-visibility subset)
      app_accountHeader: 'Account',
      app_notificationsHeader: 'Notifications',
      app_phoneNumber: 'Phone Number',
      app_storedInformation: 'Stored Information',
      app_loading: 'Loading…',
      app_language_desc: 'App language — this only changes the app\'s own text. Your CV, letters, and job content always stay in English.',

      // cv.html's own chrome (CVCase inside Telegram)
      cv_open: 'Open',
      cv_download: 'Download',
      cv_yourCv: 'Your CV',
      cv_messagePlaceholder: 'Message CVCase…',
      cv_telegramNotice: "If you're on Telegram, your CV may not open here — don't worry, we've also sent it to your CVcase Bot chat. You can open it there, and come back here any time for changes."
    },

    // ── Amharic ──────────────────────────────────────────────────────────
    am: {
      common_continue: 'ቀጥል',
      common_back: 'ተመለስ',
      common_goBack: '← ተመለስ',
      common_backToHome: '← ወደ መነሻ ተመለስ',
      common_startOver: '← እንደገና ጀምር',
      common_resendCode: 'ኮድ እንደገና ላክ',
      common_tryAgain: 'እንደገና ሞክር',
      common_maybeLater: 'ምናልባት ቆይቶ',
      common_save: 'አስቀምጥ',
      common_cancel: 'ሰርዝ',
      common_confirm: 'አረጋግጥ',
      common_edit: 'አርትዕ',
      common_processing: 'በሂደት ላይ…',
      common_pleaseWait: 'እባክዎ ይጠብቁ',
      common_saving: 'በማስቀመጥ ላይ…',
      common_saved: 'ተቀምጧል!',
      common_goingBack: 'ወደ ኋላ በመሄድ ላይ…',
      common_skipping: 'በመዝለል ላይ…',
      common_loading: 'በመጫን ላይ…',
      common_networkError: 'የአውታረ መረብ ስህተት። እባክዎ እንደገና ይሞክሩ።',
      common_home: 'መነሻ',
      common_notifications: 'ማሳወቂያዎች',
      common_account: 'መለያ',
      common_logout: 'ውጣ',
      common_logOut: 'ውጣ',
      common_logoutConfirmTitle: 'መውጣት ይፈልጋሉ?',
      common_logoutConfirmBody: 'በእርግጥ መውጣት ይፈልጋሉ?',
      common_deleteAccount: 'መለያ ሰርዝ',
      common_deleteMyAccount: 'መለያዬን ሰርዝ',
      common_language: 'ቋንቋ',
      common_dontShowAgain: 'ይህን እንደገና አታሳየኝ',
      common_openCvcaseBot: 'CVcase Bot ክፈት',
      common_appLetter: 'የማመልከቻ ደብዳቤ',
      common_applicationLetterLong: 'የማመልከቻ ደብዳቤ',
      common_pdfMerger: 'PDF አዋህድ',
      common_findJob: 'ስራ ፈልግ',

      login_title: 'ግባ ወይም ተመዝገብ',
      login_subtitle_html: 'ያስገቡ <strong>ከቴሌግራም መለያዎ ጋር የተገናኘውን ትክክለኛ የስልክ ቁጥር</strong>። እርስዎ መሆንዎን በቴሌግራም እናረጋግጣለን።',
      login_phoneLabel: 'የስልክ ቁጥር',
      login_phonePlaceholder: '09xxxxxxxx ወይም 07xxxxxxxx',
      login_tgStepTitle: 'አንድ ተጨማሪ ደረጃ',
      login_tgStepSubtitle: 'የቴሌግራም ቦታችንን ክፈቱ እና <strong>"ስልክ ቁጥሬን አጋራ"</strong>ን ይጫኑ። ኮድዎ እዚህ በራስ-ሰር ይታያል።',
      login_openBotBtn: '@cvcase_bot ክፈት',
      login_tgTimeoutTitle: 'አሁንም በመጠባበቅ ላይ',
      login_tgTimeoutBody: 'የስልክ ቁጥርዎን በቴሌግራም ማረጋገጥ አልቻልንም። ይህ ብዙ ጊዜ የሚከሰተው እዚህ ያስገቡት ቁጥር በቴሌግራም መለያዎ ከተመዘገበው ቁጥር የተለየ ሲሆን ነው፣ ወይም ገና ለቦቱ አላጋሩትም። እባክዎ ከቴሌግራም መለያዎ ጋር በተመዘገበው ተመሳሳይ ስልክ ቁጥር እንደገና ይግቡ።',
      login_otpTitle: 'ኮድ ያስገቡ',
      login_otpSubtitle: 'ወደ ቴሌግራምዎ የተላከውን 6-አሃዝ ኮድ ያስገቡ።',
      login_verifyCode: 'ኮድ አረጋግጥ',
      login_toast_codeSent: 'ኮድ ወደ ቴሌግራምዎ ተልኳል!',
      login_toast_newCode: 'አዲስ ኮድ ወደ ቴሌግራምዎ ተልኳል።',
      login_toast_rateLimited: 'በጣም ብዙ ሙከራዎች። እባክዎ ጥቂት ደቂቃዎች ይጠብቁና እንደገና ይሞክሩ።',
      login_toast_incorrectCode: 'የተሳሳተ ኮድ። እባክዎ እንደገና ይሞክሩ።',
      login_toast_couldNotResend: 'ኮድ መላክ አልተቻለም።',
      login_toast_enter6digit: 'እባክዎ 6-አሃዝ ኮዱን ያስገቡ',
      login_toast_sessionExpired: 'ክፍለ-ጊዜው አልቋል። እባክዎ እንደገና ይጀምሩ።',
      login_toast_accountDeleted: 'መለያዎ ተሰርዟል። አዲስ መለያ ለመፍጠር የስልክ ቁጥር ያስገቡ።',
      login_toast_sessionExpiredElsewhere: 'በሌላ ቦታ ስለገቡ ወጥተዋል። እባክዎ እንደገና ይግቡ።',
      login_load_verifying: 'ኮድ በማረጋገጥ ላይ…',
      login_load_resending: 'ኮድ እንደገና በመላክ ላይ…',
      login_load_signingIn: 'በማስገባት ላይ…',

      ob_step0_title: 'ሙሉ ስምዎ ማን ነው?',
      ob_step0_desc: 'ይህ በማመልከቻ ደብዳቤዎችዎ እና በCV ውህደቶችዎ ላይ ይታያል።',
      ob_fullName_placeholder: 'ለምሳሌ፦ አበበ ከበደ',
      ob_fullName_error: 'እባክዎ ሙሉ ስምዎን ያስገቡ።',
      ob_step1_title: 'ለማመልከቻ የሚውል ስልክ ቁጥር',
      ob_step1_desc: 'ይህ በደብዳቤዎችዎ እና በCV ላይ የሚታየው ቁጥር ነው — ከተመዘገቡበት ቁጥር የተለየ ሊሆን ይችላል።',
      ob_appPhone_placeholder: 'ለምሳሌ፦ 0912345678',
      ob_appPhone_hint: 'በምዝገባ ቁጥርዎ አስቀድመን እንሞላዋለን፣ ነገር ግን መቀየር ይችላሉ።',
      ob_appPhone_error: 'እባክዎ ትክክለኛ የስልክ ቁጥር ያስገቡ።',
      ob_step2_title: 'ኢሜይልዎ ምንድን ነው?',
      ob_step2_desc: 'ለማመልከቻ ደብዳቤዎች እና ለመለያ ማሳወቂያዎች ይውላል።',
      ob_email_placeholder: 'ለምሳሌ፦ abebe@email.com',
      ob_email_error: 'እባክዎ ትክክለኛ ኢሜይል አድራሻ ያስገቡ።',
      ob_step3_title: 'የአሁኑ አድራሻዎ',
      ob_step3_desc_html: 'በደብዳቤዎችዎ እና በCV ላይ ይታያል። ምሳሌ፦ <em>አዲስ አበባ፣ ኢትዮጵያ</em>።',
      ob_address_placeholder: 'ለምሳሌ፦ አዲስ አበባ፣ ኢትዮጵያ',
      ob_address_hint: 'ምክር፦ ትልቅ የኢትዮጵያ ከተማ እንዲያስገቡ እንመክራለን (ለምሳሌ፦ አዲስ አበባ፣ አዳማ፣ ባህር ዳር፣ ሐዋሳ) — እዚያ ባይሆኑም እንኳ፣ ለጽሁፍ ፈተና ወይም ቃለ መጠይቅ ከተጋበዙ መዛወር ይጠበቅብዎታል።',
      ob_address_error: 'እባክዎ አድራሻዎን ያስገቡ።',
      ob_step4_title: 'ሁሉም ነገር ዝግጁ ነው!',
      ob_step4_desc: 'መገለጫዎ ተቀምጧል። ይህንን በማንኛውም ጊዜ ከመተግበሪያው የመገለጫ ገፅ ማርትዕ ይችላሉ።',
      ob_goToApp: 'ወደ CVcase ሂድ',
      ob_settingUpAccount: 'መለያዎን በማዘጋጀት ላይ…',

      app_accountHeader: 'መለያ',
      app_notificationsHeader: 'ማሳወቂያዎች',
      app_phoneNumber: 'የስልክ ቁጥር',
      app_storedInformation: 'የተቀመጠ መረጃ',
      app_loading: 'በመጫን ላይ…',
      app_language_desc: 'የመተግበሪያው ቋንቋ — ይህ የሚቀይረው የመተግበሪያውን ራሱን ጽሑፍ ብቻ ነው። CV፣ ደብዳቤ እና የስራ ይዘትዎ ሁልጊዜ በእንግሊዝኛ ይቆያል።',

      cv_open: 'ክፈት',
      cv_download: 'አውርድ',
      cv_yourCv: 'የእርስዎ CV',
      cv_messagePlaceholder: 'ለ CVcase መልእክት…',
      cv_telegramNotice: 'በቴሌግራም ላይ ከሆኑ፣ CV ዎ እዚህ ላይከፈት ይችላል — አይጨነቁ፣ ወደ CVcase Bot ውይይትዎም ልከነዋል። እዚያ መክፈት ይችላሉ፣ እና ለውጦችን ለማድረግ በማንኛውም ጊዜ እዚህ መመለስ ይችላሉ።'
    },

    // ── Tigrinya — best-effort; please have a native speaker review before
    // relying on this in production, especially the longer sentences. ────
    ti: {
      common_continue: 'ቀጽል',
      common_back: 'ተመለስ',
      common_goBack: '← ተመለስ',
      common_backToHome: '← ናብ መበገሲ ተመለስ',
      common_startOver: '← ካብ መጀመርታ ጀምር',
      common_resendCode: 'ኮድ ደጊምካ ላኣክ',
      common_tryAgain: 'ደጊምካ ፈትን',
      common_maybeLater: 'ድሓር ይኸውን',
      common_save: 'ዓቅብ',
      common_cancel: 'ሰርዝ',
      common_confirm: 'ኣረጋግጽ',
      common_edit: 'ኣርትዕ',
      common_processing: 'ይስራሕ ኣሎ…',
      common_pleaseWait: 'በጃኹም ጽንሑ',
      common_saving: 'ይዕቀብ ኣሎ…',
      common_saved: 'ተዓቂቡ!',
      common_goingBack: 'ናብ ድሕሪት ይኸይድ ኣሎ…',
      common_skipping: 'ይሓልፍ ኣሎ…',
      common_loading: 'ይጽዕን ኣሎ…',
      common_networkError: 'ጸገም ኔትወርክ። በጃኹም ደጊምኩም ፈትኑ።',
      common_home: 'መበገሲ',
      common_notifications: 'መፍለጢታት',
      common_account: 'ኣካውንት',
      common_logout: 'ውጻእ',
      common_logOut: 'ውጻእ',
      common_logoutConfirmTitle: 'ክትወጽእ ትደሊ ዶ?',
      common_logoutConfirmBody: 'ብርግጽ ክትወጽእ ትደሊ ዶ?',
      common_deleteAccount: 'ኣካውንት ደምስስ',
      common_deleteMyAccount: 'ኣካውንተይ ደምስስ',
      common_language: 'ቋንቋ',
      common_dontShowAgain: 'ድሕሪ ደጊምካ ኣይተርእየኒ',
      common_openCvcaseBot: 'CVcase Bot ክፈት',
      common_appLetter: 'ናይ ምልክታ ደብዳበ',
      common_applicationLetterLong: 'ናይ ምልክታ ደብዳበ',
      common_pdfMerger: 'PDF ኣዋህድ',
      common_findJob: 'ስራሕ ድለ',

      login_title: 'እቶ ወይ ተመዝገብ',
      login_subtitle_html: 'ኣእቱ <strong>ምስ ቴለግራም ኣካውንትካ ዝተታሓሓዘ ልክዕ ቁጽሪ ተለፎን</strong>። ንስኻ ምዃንካ ብቴለግራም ክነረጋግጽ ኢና።',
      login_phoneLabel: 'ቁጽሪ ተለፎን',
      login_phonePlaceholder: '09xxxxxxxx ወይ 07xxxxxxxx',
      login_tgStepTitle: 'ሓንቲ ተወሳኺት ስጉምቲ',
      login_tgStepSubtitle: 'ቦት ቴለግራምና ክፈት እሞ <strong>"ቁጽሪ ተለፎነይ ኣጋራ"</strong> ጠውቕ። ኮድካ ኣብዚ ባዕሉ ክርአ እዩ።',
      login_openBotBtn: '@cvcase_bot ክፈት',
      login_tgTimeoutTitle: 'ገና ይጽበ ኣሎ',
      login_tgTimeoutBody: 'ቁጽሪ ተለፎንካ ብቴለግራም ከነረጋግጽ ኣይከኣልናን። እዚ ብዙሕ ጊዜ ዝፍጠር ኣብዚ ዘእተኻዮ ቁጽሪ ምስቲ ኣብ ቴለግራም ኣካውንትካ ዝተመዝገበ ቁጽሪ ዝተፈላለየ ክኸውን ከሎ፡ ወይ ገና ንቦቱ ዘይኣጋራኻዮ ምስ ዝኸውን እዩ። በጃኻ ምስቲ ቴለግራም ኣካውንትካ ዝተመዝገበሉ ተመሳሳሊ ቁጽሪ ተለፎን ደጊምካ እቶ።',
      login_otpTitle: 'ኮድ ኣእቱ',
      login_otpSubtitle: 'ናብ ቴለግራምካ ዝተላእከ ናይ 6 ኣሃዝ ኮድ ኣእቱ።',
      login_verifyCode: 'ኮድ ኣረጋግጽ',
      login_toast_codeSent: 'ኮድ ናብ ቴለግራምካ ተላኢኹ!',
      login_toast_newCode: 'ሓድሽ ኮድ ናብ ቴለግራምካ ተላኢኹ።',
      login_toast_rateLimited: 'ብዙሕ ፈተነታት። በጃኻ ቅሩብ ደቒቓት ጽንሕ እሞ ደጊምካ ፈትን።',
      login_toast_incorrectCode: 'ግጉይ ኮድ። በጃኻ ደጊምካ ፈትን።',
      login_toast_couldNotResend: 'ኮድ ምልኣኽ ኣይተኻእለን።',
      login_toast_enter6digit: 'በጃኻ ናይ 6 ኣሃዝ ኮድ ኣእቱ',
      login_toast_sessionExpired: 'ክፍለ-ግዜ ኣኺሉ። በጃኻ ካብ መጀመርታ ጀምር።',
      login_toast_accountDeleted: 'ኣካውንትካ ተደምሲሱ። ሓድሽ ኣካውንት ንምፍጣር ቁጽሪ ተለፎን ኣእቱ።',
      login_toast_sessionExpiredElsewhere: 'ኣብ ካልእ ቦታ ስለዝኣተኻ ወጺእካ ኣለኻ። በጃኻ ደጊምካ እቶ።',
      login_load_verifying: 'ኮድ ይረጋገጽ ኣሎ…',
      login_load_resending: 'ኮድ ደጊሙ ይልኣኽ ኣሎ…',
      login_load_signingIn: 'የእትወካ ኣሎ…',

      ob_step0_title: 'ምሉእ ሽምካ መን እዩ?',
      ob_step0_desc: 'እዚ ኣብ ናይ ምልክታ ደብዳቤታትካን ናይ CV ውህደትካን ይረአ።',
      ob_fullName_placeholder: 'ንኣብነት፦ ኣበበ ከበደ',
      ob_fullName_error: 'በጃኻ ምሉእ ሽምካ ኣእቱ።',
      ob_step1_title: 'ናይ ምልክታ ቁጽሪ ተለፎን',
      ob_step1_desc: 'እዚ ኣብ ደብዳቤታትካን CVካን ዝረአ ቁጽሪ እዩ — ካብቲ ዝተመዝገብካሉ ቁጽሪ ክፍለ ይኽእል።',
      ob_appPhone_placeholder: 'ንኣብነት፦ 0912345678',
      ob_appPhone_hint: 'ብቁጽሪ ምዝገባኻ ኣቐዲምና ክንመልኦ ኢና፣ ግን ክትቅይሮ ትኽእል ኢኻ።',
      ob_appPhone_error: 'በጃኻ ቅኑዕ ቁጽሪ ተለፎን ኣእቱ።',
      ob_step2_title: 'ኢመይልካ እንታይ እዩ?',
      ob_step2_desc: 'ንናይ ምልክታ ደብዳቤታትን ናይ ኣካውንት መፍለጢታትን ይውዕል።',
      ob_email_placeholder: 'ንኣብነት፦ abebe@email.com',
      ob_email_error: 'በጃኻ ቅኑዕ ኢመይል ኣድራሻ ኣእቱ።',
      ob_step3_title: 'ህላወ ኣድራሻኻ',
      ob_step3_desc_html: 'ኣብ ደብዳቤታትካን CVካን ይረአ። ንኣብነት፦ <em>ኣዲስ ኣበባ፣ ኢትዮጵያ</em>።',
      ob_address_placeholder: 'ንኣብነት፦ ኣዲስ ኣበባ፣ ኢትዮጵያ',
      ob_address_hint: 'ምኽሪ፦ ዓባይ ናይ ኢትዮጵያ ከተማ ክትጥቀም ንመክር (ንኣብነት፦ ኣዲስ ኣበባ፣ ኣዳማ፣ ባህር ዳር፣ ሃዋሳ) — ኣብኡ እንተዘይኮንካ እውን፡ ንጽሑፍ ፈተና ወይ ቃለ መጠይቅ እንተተዓዲምካ ክትግዕዝ ትጽቢት ይግበረካ።',
      ob_address_error: 'በጃኻ ኣድራሻኻ ኣእቱ።',
      ob_step4_title: 'ኩሉ ምድላው ተገይሩ!',
      ob_step4_desc: 'መለለዪኻ ተዓቂቡ። ነዚ ኣብ ዝኾነ ግዜ ካብ ገጽ መለለዪኻ ኣብ ናይ መተግበሪ ኣፕ ክተርትዖ ትኽእል ኢኻ።',
      ob_goToApp: 'ናብ CVcase ኺድ',
      ob_settingUpAccount: 'ኣካውንትካ ይዳሎ ኣሎ…',

      app_accountHeader: 'ኣካውንት',
      app_notificationsHeader: 'መፍለጢታት',
      app_phoneNumber: 'ቁጽሪ ተለፎን',
      app_storedInformation: 'ዝተዓቀበ ሓበሬታ',
      app_loading: 'ይጽዕን ኣሎ…',
      app_language_desc: 'ቋንቋ መተግበሪ — እዚ ጽሑፍ ናይቲ መተግበሪ ባዕሉ ጥራይ እዩ ዝቕይር። CVካ፣ ደብዳቤታትካን ናይ ስራሕ ትሕዝቶካን ኩሉ ግዜ ብእንግሊዝኛ ይተርፉ።',

      cv_open: 'ክፈት',
      cv_download: 'ኣውርድ',
      cv_yourCv: 'CVካ',
      cv_messagePlaceholder: 'ናብ CVcase መልእኽቲ…',
      cv_telegramNotice: 'ኣብ ቴለግራም እንተኣትካ፡ CVካ ኣብዚ ከይኽፈት ይኽእል — ኣይትሻቐል፡ ናብ CVcase Bot ዝርርብካ እውን ልኢኽናዮ ኣለና። ኣብኡ ክትከፍቶ ትኽእል፡ ድማ ንለውጢ ኣብ ዝኾነ ግዜ ናብዚ ክትምለስ ትኽእል ኢኻ።'
    },

    // ── Afaan Oromoo — best-effort; please have a native speaker review
    // before relying on this in production, especially the longer
    // sentences. ──────────────────────────────────────────────────────
    om: {
      common_continue: 'Itti fufi',
      common_back: 'Duubatti deebi\u2019i',
      common_goBack: '← Duubatti deebi\u2019i',
      common_backToHome: '← Gara mana galii deebi\u2019i',
      common_startOver: '← Irra deebi\u2019ii jalqabi',
      common_resendCode: 'Koodii irra deebi\u2019ii ergi',
      common_tryAgain: 'Irra deebi\u2019ii yaali',
      common_maybeLater: 'Booda ta\u2019uu danda\u2019a',
      common_save: 'Olkaa\u2019i',
      common_cancel: 'Haqi',
      common_confirm: 'Mirkaneessi',
      common_edit: 'Gulaali',
      common_processing: 'Adeemsifamaa jira…',
      common_pleaseWait: 'Maaloo eegi',
      common_saving: 'Olkaa\u2019amaa jira…',
      common_saved: 'Olkaa\u2019ameera!',
      common_goingBack: 'Gara duubaatti deemaa jira…',
      common_skipping: 'Darbaa jira…',
      common_loading: 'Fe\u2019amaa jira…',
      common_networkError: 'Dogoggora neetwoorkii. Maaloo irra deebi\u2019ii yaali.',
      common_home: 'Mana',
      common_notifications: 'Beeksisoota',
      common_account: 'Akkaawuntii',
      common_logout: 'Ba\u2019i',
      common_logOut: 'Ba\u2019i',
      common_logoutConfirmTitle: 'Ba\u2019uu barbaaddaa?',
      common_logoutConfirmBody: 'Dhuguma ba\u2019uu barbaaddaa?',
      common_deleteAccount: 'Akkaawuntii Haqi',
      common_deleteMyAccount: 'Akkaawuntii koo haqi',
      common_language: 'Afaan',
      common_dontShowAgain: 'Kana irra deebi\u2019ii na hin agarsiisin',
      common_openCvcaseBot: 'CVcase Bot Banii',
      common_appLetter: 'Xalayaa Iyyannoo',
      common_applicationLetterLong: 'Xalayaa Iyyannoo',
      common_pdfMerger: 'Walitti Qabaa PDF',
      common_findJob: 'Hojii Barbaadi',

      login_title: 'Seeni ykn galmaa\u2019i',
      login_subtitle_html: 'Galchi <strong>lakkoofsa bilbilaa akkaawuntii Telegraam keetiitiif walqabate sirrii ta\u2019e</strong>. Telegraam irratti akka sitti mirkaneessinu.',
      login_phoneLabel: 'Lakkoofsa Bilbilaa',
      login_phonePlaceholder: '09xxxxxxxx ykn 07xxxxxxxx',
      login_tgStepTitle: 'Tarkaanfii tokko dabalataa',
      login_tgStepSubtitle: 'Boota Telegraam keenya banii <strong>"Lakkoofsa bilbila koo qoodi"</strong> jedhu tuqi. Koodiin kee asitti ofumaan ni mul\u2019ata.',
      login_openBotBtn: '@cvcase_bot banii',
      login_tgTimeoutTitle: 'Ammas eegamaa jira',
      login_tgTimeoutBody: 'Lakkoofsa bilbila kee Telegraam irratti mirkaneessuu hin dandeenye. Kun yeroo baay\u2019ee kan ta\u2019u lakkoofsi asitti galchite isa akkaawuntii Telegraam keetii irratti galmaa\u2019e irraa yoo adda ta\u2019e, ykn ammaan tana boticha waliin hin qoodamin yoo ta\u2019e dha. Maaloo lakkoofsuma bilbilaa akkaawuntiin Telegraam kee ittiin galmaa\u2019e fayyadamtee irra deebi\u2019ii seeni.',
      login_otpTitle: 'Koodii Galchi',
      login_otpSubtitle: 'Koodii lakkoofsa 6 gara Telegraam keetiitti ergame galchi.',
      login_verifyCode: 'Koodii Mirkaneessi',
      login_toast_codeSent: 'Koodiin gara Telegraam keetiitti ergameera!',
      login_toast_newCode: 'Koodiin haaraan gara Telegraam keetiitti ergameera.',
      login_toast_rateLimited: 'Yaalii baay\u2019ee. Maaloo daqiiqaa muraasa eegiitii irra deebi\u2019ii yaali.',
      login_toast_incorrectCode: 'Koodiin sirrii miti. Maaloo irra deebi\u2019ii yaali.',
      login_toast_couldNotResend: 'Koodii ergu hin dandeenye.',
      login_toast_enter6digit: 'Maaloo koodii lakkoofsa 6 galchi',
      login_toast_sessionExpired: 'Yeroon seeshinii xumurameera. Maaloo irra deebi\u2019ii jalqabi.',
      login_toast_accountDeleted: 'Akkaawuntiin kee haqameera. Akkaawuntii haaraa uumuuf lakkoofsa bilbilaa galchi.',
      login_toast_sessionExpiredElsewhere: 'Bakka biraatti waan seentee turteef ba\u2019uu kee gaggeeffameera. Maaloo irra deebi\u2019ii seeni.',
      login_load_verifying: 'Koodiin mirkanaa\u2019aa jira…',
      login_load_resending: 'Koodiin irra deebi\u2019ii ergamaa jira…',
      login_load_signingIn: 'Seensisaa jira…',

      ob_step0_title: 'Maqaan kee guutuun eenyu?',
      ob_step0_desc: 'Kun xalayoota iyyannoo keetii fi walitti qabiinsa CV irratti ni mul\u2019ata.',
      ob_fullName_placeholder: 'Fakkeenyaaf: Abebe Kebede',
      ob_fullName_error: 'Maaloo maqaa kee guutuu galchi.',
      ob_step1_title: 'Lakkoofsa bilbilaa iyyannoof',
      ob_step1_desc: 'Kun lakkoofsa xalayoota keetii fi CV kee irratti mul\u2019atu dha — lakkoofsa itti galmoofte irraa adda ta\u2019uu danda\u2019a.',
      ob_appPhone_placeholder: 'Fakkeenyaaf: 0912345678',
      ob_appPhone_hint: 'Lakkoofsa galmee keetiin duraan dursinee ni guunna, garuu jijjiiruu ni dandeessa.',
      ob_appPhone_error: 'Maaloo lakkoofsa bilbilaa sirrii ta\u2019e galchi.',
      ob_step2_title: 'Imeelli kee maali?',
      ob_step2_desc: 'Xalayoota iyyannoo fi beeksisa akkaawuntiitiif fayyada.',
      ob_email_placeholder: 'Fakkeenyaaf: abebe@email.com',
      ob_email_error: 'Maaloo teessoo imeelii sirrii ta\u2019e galchi.',
      ob_step3_title: 'Teessoo ammaa kee',
      ob_step3_desc_html: 'Xalayoota keetii fi CV kee irratti ni mul\u2019ata. Fakkeenyaaf: <em>Finfinnee, Itoophiyaa</em>.',
      ob_address_placeholder: 'Fakkeenyaaf: Finfinnee, Itoophiyaa',
      ob_address_hint: 'Gorsa: magaalaa Itoophiyaa guddaa akka galchitu ni gorsina (fkn. Finfinnee, Adaamaa, Baahir Dar, Hawaasaa) — achi ta\u2019uu baattuyyuu, qormaata barreeffamaa ykn afaan-gabaasaaf affeeramuu kee yoo ta\u2019e deemuuf qophii ta\u2019uu qabda.',
      ob_address_error: 'Maaloo teessoo kee galchi.',
      ob_step4_title: 'Wanti hundi qophaa\u2019eera!',
      ob_step4_desc: 'Profaayilli kee olkaa\u2019ameera. Kana yeroo barbaaddetti fuula profaayilii appii keessaa gulaaluu dandeessa.',
      ob_goToApp: 'Gara CVcase deemi',
      ob_settingUpAccount: 'Akkaawuntii kee qopheessaa jira…',

      app_accountHeader: 'Akkaawuntii',
      app_notificationsHeader: 'Beeksisoota',
      app_phoneNumber: 'Lakkoofsa Bilbilaa',
      app_storedInformation: 'Odeeffannoo Olkaa\u2019ame',
      app_loading: 'Fe\u2019amaa jira…',
      app_language_desc: 'Afaan appii — kun kan jijjiiru barruu appichaa qofa. CV, xalayaa fi qabiyyeen hojii kee yeroo hunda Afaan Ingiliffaan ni turu.',

      cv_open: 'Bani',
      cv_download: 'Buusi',
      cv_yourCv: 'CV Kee',
      cv_messagePlaceholder: 'CVcase-f ergaa…',
      cv_telegramNotice: 'Telegraam irra yoo jiraatte, CV kee asitti hin banamu ta\u2019a — hin yaaddo\u2019in, gara haasawa CVcase Bot keetiittis ergineerra. Achitti banachuu ni dandeessa, yeroo barbaadettis jijjiirama gochuuf asitti deebi\u2019uu ni dandeessa.'
    }
  };

  function getLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) { /* storage unavailable — just default to English */ }
    return 'en';
  }

  function setLang(code) {
    if (SUPPORTED.indexOf(code) === -1) code = 'en';
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* non-fatal */ }
  }

  // Falls back to English for any key the current language hasn't filled
  // in yet, and to the key itself (so a typo is visible, not blank) if
  // even English is missing it.
  function t(key, fallback) {
    var lang = getLang();
    var dict = STRINGS[lang] || STRINGS.en;
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    if (STRINGS.en && Object.prototype.hasOwnProperty.call(STRINGS.en, key)) return STRINGS.en[key];
    return fallback !== undefined ? fallback : key;
  }

  // Walks data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-title
  // attributes under `root` (defaults to the whole document) and fills them
  // in from the current language. Safe to call repeatedly (e.g. after the
  // language changes, or after new DOM is injected/cloned).
  function applyI18n(root) {
    root = root || document;
    var byText = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < byText.length; i++) {
      byText[i].textContent = t(byText[i].getAttribute('data-i18n'));
    }
    var byHtml = root.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < byHtml.length; j++) {
      byHtml[j].innerHTML = t(byHtml[j].getAttribute('data-i18n-html'));
    }
    var byPlaceholder = root.querySelectorAll('[data-i18n-placeholder]');
    for (var k = 0; k < byPlaceholder.length; k++) {
      byPlaceholder[k].setAttribute('placeholder', t(byPlaceholder[k].getAttribute('data-i18n-placeholder')));
    }
    var byTitle = root.querySelectorAll('[data-i18n-title]');
    for (var m = 0; m < byTitle.length; m++) {
      byTitle[m].setAttribute('title', t(byTitle[m].getAttribute('data-i18n-title')));
    }
  }

  // Renders a small "en ▾" pill into `container`, with a short dropdown of
  // the other supported languages. Re-usable identically on every page.
  // opts: { bg, color, border, menuBg, hoverBg, onChange(code) }
  function buildLanguageSwitcher(container, opts) {
    opts = opts || {};
    container.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-block';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Change language');
    btn.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 10px;' +
      'border-radius:999px;border:1.5px solid ' + (opts.border || '#e2e8f0') + ';' +
      'background:' + (opts.bg || 'transparent') + ';color:' + (opts.color || '#475569') + ';' +
      "font-family:'DM Sans',sans-serif;font-size:0.78rem;font-weight:700;cursor:pointer;white-space:nowrap;";

    function renderLabel() {
      btn.innerHTML = (LABELS[getLang()] || 'en') +
        ' <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="margin-top:1px;flex-shrink:0;"><path d="M6 9l6 6 6-6"/></svg>';
    }
    renderLabel();

    var menu = document.createElement('div');
    menu.style.cssText = 'display:none;position:absolute;top:calc(100% + 6px);right:0;' +
      'background:' + (opts.menuBg || '#fff') + ';border:1px solid ' + (opts.border || '#e2e8f0') + ';' +
      'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.14);overflow:hidden;z-index:999;min-width:88px;';

    SUPPORTED.forEach(function (code) {
      var item = document.createElement('button');
      item.type = 'button';
      item.textContent = LABELS[code];
      item.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 12px;border:none;' +
        "background:none;font-family:'DM Sans',sans-serif;font-size:0.8rem;font-weight:600;" +
        'color:' + (opts.color || '#334155') + ';cursor:pointer;';
      item.onmouseenter = function () { item.style.background = opts.hoverBg || '#f1f5f9'; };
      item.onmouseleave = function () { item.style.background = 'none'; };
      item.onclick = function () {
        setLang(code);
        renderLabel();
        menu.style.display = 'none';
        applyI18n(document);
        if (typeof opts.onChange === 'function') opts.onChange(code);
      };
      menu.appendChild(item);
    });

    btn.onclick = function (e) {
      e.stopPropagation();
      menu.style.display = (menu.style.display === 'block') ? 'none' : 'block';
    };
    document.addEventListener('click', function () { menu.style.display = 'none'; });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    container.appendChild(wrap);
  }

  global.CVI18n = {
    getLang: getLang,
    setLang: setLang,
    t: t,
    applyI18n: applyI18n,
    buildLanguageSwitcher: buildLanguageSwitcher,
    SUPPORTED: SUPPORTED,
    LABELS: LABELS,
    NAMES: NAMES
  };
})(window);
# 🔐 Privacy Policy — TextPocket Extension

Last updated: April 2026

TextPocket respects your privacy.  
This extension is designed to work **entirely on your device**, without collecting or transmitting any personal data.

---

## ✅ Information We Collect

**We do not collect, store, or transmit any personal information.**  
TextPocket does not use analytics, tracking scripts, external servers, or cookies.

The extension only stores **your snippets, folders, and settings** locally inside your browser, using the built‑in `chrome.storage.local` API.

---

## ✅ How Data Is Used

Your data (snippets, folders, trigger character, theme, language) is stored **only on your device** so the extension can:

- Display your snippet library in the popup
- Power the autocomplete dropdown when you type the trigger character
- Open TextPocket as a floating window via the global shortcut
- Save your theme and language preferences

None of this information ever leaves your browser.

---

## ✅ Permissions Explanation

TextPocket uses these browser permissions:

| Permission | Why |
|------------|-----|
| `storage` | To save your snippets, folders, and settings locally on your device.|
| `tabs` |To notify open tabs when you add or edit a snippet, so the autocomplete dropdown stays in sync. |
| `system.display` | To correctly center the TextPocket popup window on your screen when opened via the global shortcut. |
| `clipboardWrite` | To write snippet content before simulated paste, so the snippet is inserted correctly into the input fields or editors. |
| `clipboardRead` | Save and restore your clipboard around each paste |
| `<all_urls> (Host Permission)` | Required to inject the autocomplete script into any website you visit, so the trigger character works across all sites. This does **not** mean the extension reads, stores, or transmits the content of those pages — it only activates when you type the trigger character in a field you are actively editing.|


No other permissions are used. TextPocket does **not** request access to your browsing history, cookies, webcam, microphone, or any sensitive browser data.

---

## ✅ Content Script Behavior

TextPocket injects a small script (`content.js`) into web pages to detect when you type the trigger character and to insert snippet text at your cursor.

This script:
- **Only reads** keyboard input in fields you are actively editing
- **Does not** read, scan, copy, or store the content of any web page
- **Does not** transmit anything to any server

---

## ✅ Third‑Party Services

The extension does **not** send data to any third party.  
TextPocket operates fully offline. No external API, analytics service, or remote server is involved at any point.

---

## ✅ Children's Privacy

TextPocket does not collect personal data from anyone, including children under 13.

---

## ✅ Contact

If you have privacy questions, feel free to contact the developer:

**Email:** *hassananayi@gmail.com*

---

Thank you for using TextPocket!

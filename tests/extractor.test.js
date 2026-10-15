// Checks the code extractor in apps-script/Code.gs against realistic emails.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gs-')), 'Code.gs.js');
fs.copyFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), tmpFile);
const { extractCode_, htmlToText_ } = require(tmpFile);

const cases = [
  { name: 'plain basic', subject: 'Your verification code', body: 'Hi Jude,\n\nYour verification code is 482913.\n\nThis code expires in 10 minutes.', want: '482913' },
  { name: 'code in subject', subject: '482913 is your Instagram code', body: 'Hi, someone tried to log in to your Instagram account. If this was you, enter the code above. © 2026 Meta', want: '482913' },
  { name: 'google G- prefix', subject: 'G-739204 is your Google verification code', body: 'G-739204 is your Google verification code.', want: '739204' },
  { name: 'html standalone + footer', subject: 'Verify your sign-in', html: `<html><head><style>.a{color:red}</style></head><body><table><tr><td><h1>Confirm it's you</h1></td></tr><tr><td><p>Use the code below to finish signing in to High Desert Corporate Filings.</p></td></tr><tr><td style="font-size:32px"><strong>551028</strong></td></tr><tr><td><p>It expires in 15 minutes.</p></td></tr><tr><td>High Desert Corporate Filings LLC, 1810 E Sahara Ave, Suite 214, Las Vegas, NV 89104</td></tr><tr><td>© 2026 All rights reserved. <a href="https://example.com/u?id=889912">Unsubscribe</a></td></tr></table></body></html>`, want: '551028' },
  { name: '4-digit login code', subject: 'Your login code', body: 'Your login code: 4829\nIf you did not request this, ignore this email.', want: '4829' },
  { name: 'google voice forwarded sms', subject: 'New text message from (775) 555-0142', body: 'Your High Desert Corporate Filings verification code is 739205. Do not share this code.\n\nTo respond to this text message, reply to this email or visit Google Voice.\n\nYOUR ACCOUNT HELP CENTER HELP FORUM\n\nYou received this message because your Google Voice settings are set to forward text messages to your email.\n\nGoogle LLC 1600 Amphitheatre Parkway, Mountain View CA 94043 USA', want: '739205' },
  { name: 'order confirmation (no otp)', subject: 'Order #123456 confirmed', body: 'Thanks for your order #123456! Use promo code SAVE20 on your next order. Track at https://x.com/t/9988776', want: null },
  { name: 'newsletter promo', subject: 'Spring sale!', body: 'Use code SPRING2026 for 20% off. Offer ends 04/30/2026. 1234 Main St, Springfield, IL 62701', want: null },
  { name: 'bank 8-digit + phone', subject: 'Your one-time passcode', body: 'Your one-time passcode is 58291037. Do not share it with anyone. Questions? Call 1-800-555-0199.', want: '58291037' },
  { name: 'split 3-3', subject: 'Sign in to Acme', body: 'Enter this code to sign in:\n\n 914 382 \n\nThis code will expire in 10 minutes.', want: '914382' },
  { name: 'spaced digits from html cells', subject: 'Your verification code', html: '<p>Your verification code:</p><table><tr><td>4</td><td>8</td><td>2</td><td>9</td><td>1</td><td>3</td></tr></table>', want: '482913' },
  { name: 'microsoft security code', subject: 'Microsoft account security code', body: 'Microsoft account\nSecurity code\n\nPlease use the following security code for the Microsoft account jo*****@gmail.com.\n\nSecurity code: 2918\n\nIf you don\'t recognize the Microsoft account jo*****@gmail.com, you can click here to remove your email address from that account.\n\nThanks,\nThe Microsoft account team', want: '2918' },
  { name: 'date near code', subject: 'Verification code', body: 'Requested on October 15, 2026 at 12:21 PM.\nYour code is 663201.', want: '663201' },
  { name: 'magic link only', subject: 'Sign in to Notion', body: 'Click here to sign in: https://www.notion.so/loginwithemail?token=123456789&state=55512\nThis link expires in 15 minutes.', want: null },
  { name: 'alnum code', subject: 'Your sign-in code', body: 'Your code is: 7XK2P9\nIt expires soon.', want: '7XK2P9' },
  { name: 'steam guard', subject: 'Your Steam account: Access from new web or mobile device', body: 'Hello,\n\nHere is the Steam Guard code you need to login to account jude:\n\nFV3QT\n\nThis email was generated because of a login attempt from a web or mobile device located at Reno, NV, US.', want: 'FV3QT' },
  { name: 'account ending + code', subject: 'Verify it\'s you', body: 'We noticed a sign in to your account ending in 4821. Your verification code is 553201.', want: '553201' },
  { name: 'code after number', subject: 'Acme', body: '123456 is your verification code for Acme. Don\'t share it.', want: '123456' },
  { name: 'phone mention then code', subject: 'Security alert', body: 'We sent a code to (775) 555-0142. Your code is 112233.', want: '112233' },
  { name: 'shipping no otp', subject: 'Your package has shipped', body: 'Tracking number: 940011189922385. Estimated delivery Oct 18. Zip code 89104.', want: null },
  { name: 'github notification', subject: '[repo] Fix login bug (#1234)', body: 'Merged #1234 into main. Code review by @someone. 3 files changed, 120 additions.', want: null },
  { name: 'hyphen alnum', subject: 'Your Acme verification code', body: 'Your verification code is AB3-9KD. Enter it to continue.', want: 'AB3-9KD' },
  { name: 'pin number', subject: 'Your PIN', body: 'Your one-time PIN number: 8841', want: '8841' },
  { name: 'year-like code right after', subject: 'Login code', body: 'Your login code is 2019', want: '2019' },
  { name: 'receipt with verification word', subject: 'Verify your email', body: 'Please verify your email address by clicking the button below.\n\nAcme Inc, Unit 4021, Reno NV 89501', want: null },
  { name: 'preheader + big code', subject: 'Your Slack confirmation code', html: '<div style="display:none">Confirm your email address&zwnj;&nbsp;&zwnj;&nbsp;</div><h1>Confirm your email address</h1><p>Your confirmation code is below — enter it in your open browser window and we\'ll help you get signed in.</p><div class="code">QW4-8ZT</div><p>If you didn’t request this email, there’s nothing to worry about.</p><p>©2026 Slack Technologies, LLC. 500 Howard Street, San Francisco, CA 94105</p>', want: 'QW4-8ZT' },
  { name: 'amazon otp', subject: 'amazon.com: Sign-in attempt', body: 'To continue, complete this verification step. We\'ve sent a One Time Password (OTP) to the email address on your account. Please enter it below to complete verification.\n\n281604\n\nDon\'t share this OTP with anyone.', want: '281604' },
  { name: 'sign-in alert, no code', subject: 'New sign-in to your account', body: 'We noticed a new sign-in to your account from Chrome on Mac near Reno, NV (IP 73.22.101.5) on Oct 15, 2026 at 12:21 PM. Device ID: 88213345. If this was you, no action is needed.', want: null },
  { name: 'code + request id', subject: 'Your verification code', body: 'Your verification code is 640017.\n\nRequest ID: A1B2C3D4\nISO-8601 timestamp attached.', want: '640017' },
  { name: 'code in subject, footer numbers', subject: 'Your Acme code is 902114', body: 'Hi Jude, here is the code you asked for. Acme Inc. 2211 Market Street, San Francisco, CA 94114. Call 415-555-0102.', want: '902114' },
  { name: 'expires in 1440 minutes w/ code', subject: 'Your code', body: 'Your access code is 330198 and expires in 1440 minutes.', want: '330198' },
];

let pass = 0;
for (const c of cases) {
  const body = c.html ? htmlToText_(c.html) : c.body;
  const r = extractCode_(c.subject, body);
  const got = r ? r.code : null;
  const ok = got === c.want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(32)} want=${String(c.want).padEnd(9)} got=${String(got).padEnd(9)} ${r ? `score=${r.score} ${r.confidence}` : ''}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);

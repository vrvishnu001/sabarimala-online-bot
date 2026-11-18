// bot.js - config-driven version of test.js (driven by the UI via server.js)

const { chromium } = require('playwright');

let LOG = (line) => process.stdout.write(line + '\n');
const console = {
    log: (...a) => LOG(a.join(' ')),
    error: (...a) => LOG(a.map(x => (x && x.message) || x).join(' ')),
};
let STOPPED = false;
let activeBrowser = null;
let slotApiDiagnostics = [];

// Set these as environment variables, or replace the placeholders below.
//   Windows (cmd):        set SABARI_USER=xxxx && set SABARI_PASS=xxxx && node uthai.js
//   Windows (PowerShell): $env:SABARI_USER="xxxx"; $env:SABARI_PASS="xxxx"; node uthai.js
let USERNAME = process.env.SABARI_USER || '';
let PASSWORD = process.env.SABARI_PASS || '';

// -------------------------------------------------------------------------
// --- 1. CONFIGURATION CONSTANTS ---
// -------------------------------------------------------------------------

// Dates to check (use 3-letter month format: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)
// Put your most preferred date FIRST. The first one found available is selected.
let TARGET_DATES = [
    { label: 'Nov 24', day: '24', month: 'Nov', year: '2026' },
    { label: 'Dec 17', day: '17', month: 'Dec', year: '2026' },
    // { label: 'Jan 14', day: '14', month: 'Jan', year: '2027' },
];

// Pilgrim rows to tick on the pilgrim selection page (row numbers, starting from 1).
// Example: [1, 3] selects the 1st and 3rd pilgrim rows.
let PILGRIM_ROWS = [2,3,4,5];

// Nominee details. The site has one nominee row per selected pilgrim, and this
// SAME nominee is filled in EVERY row (2, 3, 4, 5 pilgrims... any count).
//   name:     letters and spaces only, max 32 characters
//   age:      digits only, max 3 digits
//   relation: Father, Mother, Son, Daughter, Brother, Sister, Spouse
let DEFAULT_NOMINEE = { name: 'Example Nominee', age: '30', relation: 'Father' };

// Optional: use a different nominee for a specific pilgrim row (row number starts at 1).
// Rows not listed here use DEFAULT_NOMINEE.
let NOMINEE_OVERRIDES = {
    // 2: { name: 'Kumar', age: '28', relation: 'Brother' },
};

// Relation name -> dropdown option value on the site
const RELATION_VALUES = {
    father: '1',
    mother: '2',
    son: '3',
    daughter: '4',
    brother: '5',
    sister: '6',
    spouse: '11',
};

// The specific Route option value for "Pamba - Marakkoottam - 4 Kms"
let ROUTE_VALUE = '1';
const ROUTE_SELECTOR = 'select[name="reportingPlace"]';

// Selector for any available time slot div (used to check if slots loaded)
const AVAILABLE_SLOT_SELECTOR = 'div.slot-dar-5:has-text("Availability:")';

// Selector for the clickable parent element of the time slot
const TIME_SLOT_CLICK_PARENT = '.slot-media:has(.slot-dar-5:has-text("Availability:"))';

// Slot selection mode:
//   1 = AUTO       -> script picks the slot itself (first slot that fits all pilgrims,
//                     otherwise the slot with the most seats).
//   0 = PARTICULAR -> script picks only from SLOT_PREFERENCES below.
let AUTO_SLOT_SELECTION = 1;

// Used only when AUTO_SLOT_SELECTION = 0. Write the time exactly as the site shows it.
// Put your most preferred slot FIRST; the first one that has seats is selected.
// If none of them has seats, the round restarts (it will NOT fall back to another slot).
let SLOT_PREFERENCES = [
    '05:00 - 06:00',
    // '10:00 - 11:00',
    // '11:00 - 12:00',
];

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// --- Timeout settings ---
// Every click / fill / wait / navigation gives up after this many ms (Playwright's default is 30000).
const ACTION_TIMEOUT_MS = 10000;
// Only two waits stay longer, because the site can be slow there: the slot cards
// loading after the route is picked, and the payment page loading after "Proceed".
const SLOW_WAIT_MS = 30000;

// --- Multi-round booking settings ---
// If a round fails (no slot, page error, booking not confirmed...), the whole flow restarts
// from the first step (the wishlist is cleared again) and the same pilgrims are retried.
// Stop only after this many failures in a row, so a permanent problem does not loop forever.
let MAX_CONSECUTIVE_FAILURES = 20;
let RETRY_DELAY_MS = 5000;

// How many times to click "Add to Wishlist" if the Proceed popup does not appear.
const ADD_TO_WISHLIST_ATTEMPTS = 3;

// --- Booking success check ---
// A round counts as BOOKED only when one of these is seen after the final "Proceed":
//   1) the page has left the /darshan booking page (e.g. payment gateway or confirmation page), OR
//   2) the URL matches BOOKING_SUCCESS_URL_REGEX, OR
//   3) the page text matches BOOKING_SUCCESS_TEXT_REGEX.
// If none appears within SLOW_WAIT_MS, the round is treated as NOT booked and retried.
// Tune these two patterns using the "Final page URL / Final page text" lines in the log.
const BOOKING_SUCCESS_URL_REGEX = /payment|ticket|confirm|success|receipt|invoice/i;
const BOOKING_SUCCESS_TEXT_REGEX = /booking (is )?(successful|confirmed)|successfully (booked|added)|booking id|ticket (no|number)|transaction id|payment (successful|success)/i;

// Remembers who each pilgrim row is (by its text), so after some pilgrims are booked
// and the list changes, the remaining ones are still found correctly.
const pilgrimIdentity = {};

// -------------------------------------------------------------------------
// --- 2. MAIN EXECUTION FUNCTION ---
// -------------------------------------------------------------------------

async function runBookingBot() {
    let browser;
    try {
        // Launch your installed Google Chrome instead of Playwright's bundled Chromium.
        // If 'channel: "chrome"' fails, comment it out and uncomment 'executablePath'.
        const launchOpts = { headless: HEADLESS };
        if (USE_INSTALLED_CHROME) launchOpts.channel = 'chrome';
        browser = await chromium.launch(launchOpts);
        activeBrowser = browser;
        const page = await browser.newPage({
            viewport: { width: 1366, height: 850 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });

        // All actions and navigations time out after 10 seconds instead of 30.
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);

        page.on('response', (response) => {
            const request = response.request();
            if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
            const host = new URL(response.url()).hostname || 'unknown host';
            slotApiDiagnostics.push(`${request.method()} ${host} ${response.status()}`);
            if (slotApiDiagnostics.length > 30) slotApiDiagnostics.shift();
        });
        page.on('requestfailed', (request) => {
            if (request.resourceType() !== 'xhr' && request.resourceType() !== 'fetch') return;
            const host = new URL(request.url()).hostname || 'unknown host';
            const failure = request.failure();
            const reason = failure && failure.errorText ? `: ${failure.errorText}` : '';
            slotApiDiagnostics.push(`${request.method()} ${host} failed${reason}`);
            if (slotApiDiagnostics.length > 30) slotApiDiagnostics.shift();
        });
        page.on('pageerror', (error) => console.error(`Browser page error: ${error.message}`));

        let remaining = [...PILGRIM_ROWS]; // pilgrim rows still NOT confirmed booked
        for (const k of Object.keys(pilgrimIdentity)) delete pilgrimIdentity[k];
        let failures = 0;
        let round = 0;

        while (remaining.length > 0 && !STOPPED) {
            round++;
            console.log(`\n==================== ROUND ${round} ====================`);
            console.log(`Pilgrims still to book (rows): ${remaining.join(', ')}`);

            try {
                // Returns rows only after the booking was CONFIRMED (see verifyBookingSuccess).
                const bookedRows = await runOneRound(page, remaining);

                if (!bookedRows || bookedRows.length === 0) {
                    throw new Error('No pilgrim could be booked in this round.');
                }

                // Confirmed booked -> remove them from the remaining list.
                remaining = remaining.filter((r) => !bookedRows.includes(r));
                failures = 0;
                console.log(`✅ Booked row(s): ${bookedRows.join(', ')}. Remaining: ${remaining.length ? remaining.join(', ') : 'none'}`);
            } catch (err) {
                if (STOPPED) break;
                // Not confirmed / any failure: the pilgrims of this round stay in "remaining".
                // The next round clears the wishlist and books them again.
                failures++;
                console.error(`⚠️ Round ${round} failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message.split('\n')[0]}`);
                console.log(`Still not booked: rows ${remaining.join(', ')}`);
                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log('🛑 Too many failures in a row. Stopping automation.');
                    break;
                }
                console.log(`Restarting from the initial step (wishlist will be cleared) in ${RETRY_DELAY_MS / 1000} seconds...`);
                await page.waitForTimeout(RETRY_DELAY_MS);
            }
        }

        if (STOPPED) {
            console.log('\n⏹ Stopped by user.');
        } else if (remaining.length === 0) {
            console.log('\n🎉 ALL PILGRIMS ARE BOOKED. Automation finished.');
        } else {
            console.log(`\n🛑 Automation stopped. Pilgrim rows NOT booked: ${remaining.join(', ')}`);
        }

    } catch (error) {
        if (STOPPED) console.log('\n⏹ Stopped by user.');
        else console.error('--- 🛑 AN UNRECOVERABLE ERROR OCCURRED ---', error);
    } finally {
        activeBrowser = null;
        if (browser) await browser.close().catch(() => {});
    }
}

/**
 * One full booking pass (login -> clear wishlist -> date -> route/slot -> pilgrims -> nominees -> checkout)
 * for as many of the remaining pilgrims as the chosen slot has room for.
 * Returns the list of pilgrim rows ONLY if the booking was confirmed; otherwise it throws.
 */
async function runOneRound(page, remaining) {
    console.log('--- STARTING LOGIN & NAVIGATION ---');
    await loginAndOpenBookingPage(page); // always clears the wishlist if it has an item

    // Date selection (loops/refreshes until the target date is available)
    const dateSelected = await selectDateOnly(page);
    if (!dateSelected) {
        throw new Error('Failed to select a date.');
    }

    // Route + slot. The slot's availability decides how many pilgrims we can book now.
    const slot = await selectRouteAndSlot(page, remaining.length);
    if (!slot.ok) {
        throw new Error('Failed to select a slot after route selection.');
    }

    const countThisRound = Math.min(slot.availability, remaining.length);
    const rowsThisRound = remaining.slice(0, countThisRound);

    if (countThisRound < remaining.length) {
        console.log(`ℹ️ Only ${slot.availability} seat(s) available but ${remaining.length} pilgrim(s) remain. Booking ${countThisRound} now, the rest in the next round.`);
    } else {
        console.log(`ℹ️ Enough seats (${slot.availability}) for all ${remaining.length} remaining pilgrim(s).`);
    }

    // Select "Others (Upto 5 Pilgrims)"
    try {
        await page.locator('mat-radio-button:has-text("Others")').first().locator('label').click({ timeout: 3000 });
    } catch (e) {
        await page.click('#mat-radio-3'); // fallback to the original selector
    }
    console.log('Selected "Others" group option.');

    // Click Select Pilgrim Button
    await Promise.all([
        page.waitForURL('**/piligrimServiceMaster', { timeout: ACTION_TIMEOUT_MS }),
        page.click('button:has-text("Select Pilgrim")')
    ]);
    console.log('Clicked "Select Pilgrim" and navigated to selection page.');

    // Select only the pilgrims that fit
    const selectedRows = await selectPilgrims(page, rowsThisRound);
    if (selectedRows.length === 0) {
        throw new Error('No pilgrim could be ticked on the selection page.');
    }

    // Submit on pilgrim page
    await Promise.all([
        page.waitForURL('**/darshan', { timeout: ACTION_TIMEOUT_MS }),
        page.click('button#regi_continue:has-text("Submit")')
    ]);
    console.log('Clicked Submit on Pilgrim page and returned to darshan page.');

    // Nominee details (every nominee row on the page)
    await fillNominees(page);

    // "No" for both contribution options
    await selectContributionNo(page);

    // Wishlist & checkout steps (throws if the booking is not confirmed)
    await handleFinalSteps(page);

    return selectedRows;
}

// -------------------------------------------------------------------------
// --- 3. HELPER FUNCTIONS ---
// -------------------------------------------------------------------------

/**
 * Initial steps: open the site, login if needed, go to the Virtual-Q booking page,
 * then clear the wishlist if it has an item. Runs at the start of EVERY round.
 */
async function loginAndOpenBookingPage(page) {
    await page.goto('https://sabarimalaonline.org/#/darshan');

    let needLogin = false;
    try {
        await page.waitForSelector('#email', { state: 'visible', timeout: 6000 });
        needLogin = true;
    } catch (e) {
        needLogin = false;
    }

    if (needLogin) {
        await page.fill('#email', USERNAME);
        await page.fill('#password', PASSWORD);
        await Promise.all([
            page.waitForURL('**/home', { timeout: ACTION_TIMEOUT_MS }),
            page.click('#regi_continue')
        ]);
        console.log('Login attempt successful.');
    } else {
        console.log('Already logged in.');
    }

    if (!page.url().includes('/darshan')) {
        await page.waitForSelector('#container', { state: 'visible', timeout: ACTION_TIMEOUT_MS });
        await Promise.all([
            page.waitForURL('**/darshan', { timeout: ACTION_TIMEOUT_MS }),
            page.click('#container')
        ]);
    }
    console.log('Navigated to Virtual-Q booking page.');

    // Clear any old wishlist item BEFORE doing the normal flow
    await clearWishlistIfPresent(page);

    await page.waitForSelector(ROUTE_SELECTOR, { state: 'visible', timeout: ACTION_TIMEOUT_MS });
    console.log('Booking page elements are stable. Starting checks.');
}

/**
 * If the wishlist box has an item (the "Clear Wishlist" button is visible),
 * clears it and confirms the popup. Does nothing when the wishlist is empty.
 */
async function clearWishlistIfPresent(page) {
    console.log('--- CHECKING WISHLIST ---');
    try {
        const clearBtn = page.locator('#wishlist-box button:has-text("Clear Wishlist")');

        // Give the wishlist box a moment to render; if no button appears, it's empty
        try {
            await clearBtn.waitFor({ state: 'visible', timeout: 3000 });
        } catch (e) {
            console.log('Wishlist is empty. Continuing.');
            return;
        }

        await clearBtn.click({ timeout: ACTION_TIMEOUT_MS });
        console.log('Clicked "Clear Wishlist".');

        // Confirmation popup: "Are you sure you want to clear the Wishlist?" -> Yes
        const yesBtn = page.locator('button.btn-addto-pop:has-text("Yes")');
        await yesBtn.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
        await yesBtn.click({ timeout: ACTION_TIMEOUT_MS });

        // Wait until the Clear Wishlist button disappears (wishlist actually cleared)
        await clearBtn.waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS });
        console.log('✅ Wishlist cleared.');
    } catch (err) {
        console.log(`⚠️ Wishlist clear failed: ${err.message.split('\n')[0]}`);
        throw err; // restarts the round so we never continue with a stale wishlist
    }
}

/**
 * Builds an exact-match regex for a calendar cell's aria-label.
 * Matches: "Dec 20 2026", "Dec 20, 2026", "December 20, 2026", "December 20 2026", "Dec 020 2026" (leading zero)
 * Does NOT match "Dec 2 2026", "Dec 21 2026", etc.
 */
function buildLabelRegex(targetDate) {
    const dayNum = String(parseInt(targetDate.day, 10));
    return new RegExp(
        `^${targetDate.month}[a-z]*\\.?\\s+0?${dayNum},?\\s+${targetDate.year}$`,
        'i'
    );
}

/**
 * Dynamically navigates the Angular Material calendar to the exact month and year
 * specified in TARGET_DATES and selects the exact target day (only if it is enabled).
 */
async function selectDateOnly(page) {
    console.log('--- STARTING DATE CHECK LOOP (Dynamic Month/Year Navigation) ---');

    const nextMonthBtn = page.locator('button.mat-calendar-next-button[aria-label="Next month"]');
    const prevMonthBtn = page.locator('button.mat-calendar-previous-button[aria-label="Previous month"]');
    const periodHeader = page.locator('.mat-calendar-period-button');
    const calendarToggleButton = page.locator('mat-datepicker-toggle button').first();
    const calendarBody = page.locator('.mat-calendar-body');

    while (true) {
        if (STOPPED) throw new Error('Stopped');
        let dateFound = false;
        let stage = 'waiting for the date picker button';
        try {
            await calendarToggleButton.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });

            stage = 'opening the date picker';
            if (!await calendarBody.isVisible()) {
                await calendarToggleButton.click({ timeout: ACTION_TIMEOUT_MS });
            }
            stage = 'waiting for the calendar grid';
            await calendarBody.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
            console.log('Calendar loaded. Checking available dates...');
            stage = 'checking target dates';

            for (const targetDate of TARGET_DATES) {
                const targetMonthIndex = MONTH_NAMES.indexOf(targetDate.month.toUpperCase());
                const targetYear = parseInt(targetDate.year, 10);

                if (targetMonthIndex === -1) {
                    console.log(`⚠️ Invalid month format in TARGET_DATES: "${targetDate.month}". Use 3-letter format (e.g., Nov, Dec, Jan).`);
                    continue;
                }

                // Navigate forward or backward up to 12 months until header matches target month & year
                for (let step = 0; step < 12; step++) {
                    const headerText = (await periodHeader.innerText()).trim().toUpperCase();
                    const currentMonthIndex = MONTH_NAMES.findIndex(m => headerText.includes(m));
                    const yearMatch = headerText.match(/\d{4}/);
                    const currentYear = yearMatch ? parseInt(yearMatch[0], 10) : targetYear;

                    // Stop navigating once calendar displays the target month and year
                    if (currentMonthIndex === targetMonthIndex && currentYear === targetYear) {
                        break;
                    }

                    const isTargetAhead =
                        targetYear > currentYear ||
                        (targetYear === currentYear && targetMonthIndex > currentMonthIndex);

                    if (isTargetAhead) {
                        if (await nextMonthBtn.isDisabled()) {
                            console.log(`⚠️ Cannot navigate further forward to ${targetDate.month} ${targetDate.year} (Next button disabled).`);
                            break;
                        }
                        await nextMonthBtn.click();
                    } else {
                        if (await prevMonthBtn.isDisabled()) {
                            console.log(`⚠️ Cannot navigate further backward to ${targetDate.month} ${targetDate.year} (Previous button disabled).`);
                            break;
                        }
                        await prevMonthBtn.click();
                    }

                    // Brief pause so Angular re-renders the month grid before reading the header again
                    await page.waitForTimeout(250);
                }

                // Confirm the calendar really landed on the target month/year before looking for the day
                const finalHeader = (await periodHeader.innerText()).trim().toUpperCase();
                const finalYearMatch = finalHeader.match(/\d{4}/);
                const onTargetMonth =
                    finalHeader.includes(MONTH_NAMES[targetMonthIndex]) &&
                    finalYearMatch &&
                    parseInt(finalYearMatch[0], 10) === targetYear;

                if (!onTargetMonth) {
                    console.log(`⚠️ Calendar is showing "${finalHeader}", not ${targetDate.month} ${targetDate.year}. Skipping.`);
                    continue;
                }

                // Find the exact day cell in the month currently displayed.
                // The calendar is already on the target month/year (checked above), so the
                // visible day number is the most reliable thing to match. aria-label is a fallback.
                const dayNum = String(parseInt(targetDate.day, 10));
                const labelRegex = buildLabelRegex(targetDate);
                const cells = page.locator('td.mat-calendar-body-cell');
                const count = await cells.count();
                let dateCell = null;
                let dayExistsButUnavailable = false;
                const debugRows = [];

                for (let i = 0; i < count; i++) {
                    const cell = cells.nth(i);
                    const text = ((await cell.innerText()) || '').trim();
                    const label = ((await cell.getAttribute('aria-label')) || '').trim();
                    const cls = (await cell.getAttribute('class')) || '';
                    const ariaDisabled = await cell.getAttribute('aria-disabled');

                    debugRows.push(`text="${text}" | label="${label}" | disabled=${ariaDisabled} | class="${cls}"`);

                    const dayMatches = text === dayNum || labelRegex.test(label);
                    if (!dayMatches) continue;

                    const isDisabled = ariaDisabled === 'true' || cls.includes('mat-calendar-body-disabled');
                    const isAvailable = cls.includes('example-custom-date-class');

                    if (isAvailable && !isDisabled) {
                        dateCell = cell;
                        break;
                    } else {
                        dayExistsButUnavailable = true;
                    }
                }

                if (!dateCell) {
                    if (dayExistsButUnavailable) {
                        console.log(`ℹ️ ${targetDate.label} ${targetDate.year} is in the calendar but not available yet.`);
                    } else {
                        console.log(`⚠️ Could not find a cell for ${targetDate.label} ${targetDate.year}. Cells seen:`);
                        debugRows.forEach(r => console.log('   ' + r));
                    }
                }

                if (dateCell && await dateCell.isVisible()) {
                    console.log(`✅ Date Available: ${targetDate.label} ${targetDate.year}. Selecting...`);

                    await Promise.all([
                        page.waitForSelector('.mat-calendar-body', { state: 'hidden', timeout: ACTION_TIMEOUT_MS }),
                        dateCell.click({ force: true, timeout: ACTION_TIMEOUT_MS })
                    ]);

                    dateFound = true;
                    break;
                }
            }

            if (dateFound) {
                console.log('--- ✅ DATE SELECTED. Proceeding to Route Selection. ---');
                return true;
            } else {
                // Close the calendar with Escape (clicking the toggle again can be blocked by the overlay)
                await page.keyboard.press('Escape').catch(() => {});
                console.log('No available dates. Refreshing after 7 seconds...');
                await page.waitForTimeout(7000);
                await page.reload();
            }

        } catch (err) {
            if (STOPPED) throw new Error('Stopped');
            console.log(`Error while checking dates (${stage}): ${err.message.split('\n')[0]}`);
            await page.waitForTimeout(7000);
            await page.reload();
        }
    }
}

/**
 * Selects the route and then picks a slot based on its "Availability: N" number.
 *  - Prefers the first slot that has enough seats for ALL pilgrims still needed.
 *  - If no slot is big enough, picks the slot with the MOST seats (partial booking).
 * Returns { ok, availability } where availability is the seat count of the chosen slot.
 */
async function selectRouteAndSlot(page, neededCount) {
    console.log('--- STARTING ROUTE SELECTION ---');
    slotApiDiagnostics = [];

    await page.waitForSelector(`${ROUTE_SELECTOR}:not([disabled])`, {
        state: 'visible',
        timeout: ACTION_TIMEOUT_MS,
    });

    await page.selectOption(ROUTE_SELECTOR, ROUTE_VALUE);

    const finalValue = await page.$eval(ROUTE_SELECTOR, el => el.value);

    if (finalValue !== ROUTE_VALUE) {
        console.log(`⚠️ Expected route value "${ROUTE_VALUE}" but got: ${finalValue}. Cannot proceed.`);
        return { ok: false, availability: 0 };
    } else {
        console.log('✅ Route selected: Pamba - Marakkoottam - 4 Kms');
    }

    console.log('--- STARTING SLOT SELECTION ---');

    let slotStage = 'waiting for slot availability';
    try {
        await page.waitForSelector(AVAILABLE_SLOT_SELECTOR, { timeout: SLOW_WAIT_MS });
        slotStage = 'reading slot details';
        await page.waitForTimeout(500); // let all slot cards finish rendering

        const slots = page.locator(TIME_SLOT_CLICK_PARENT);
        const slotCount = await slots.count();

        // Read the time and seat count of every slot
        const slotInfo = [];
        for (let i = 0; i < slotCount; i++) {
            const slot = slots.nth(i);
            const time = ((await slot.locator('.slot-dar-3').first().innerText()) || '').trim();
            const text = (await slot.locator('.slot-dar-5').first().innerText()) || '';
            const m = text.match(/Availability:\s*(\d+)/i);
            const seats = m ? parseInt(m[1], 10) : null; // null = could not read the number
            slotInfo.push({ index: i, time, seats });
        }
        console.log('Slots found: ' + slotInfo.map(s => `${s.time}=${s.seats === null ? '?' : s.seats}`).join(' | '));

        // Ignore slots that clearly have 0 seats
        const usable = slotInfo.filter(s => s.seats === null || s.seats > 0);
        if (usable.length === 0) {
            console.log('⚠️ Route selected, but every slot has 0 seats.');
            return { ok: false, availability: 0 };
        }

        let chosen = null;

        if (AUTO_SLOT_SELECTION === 1) {
            // AUTO: first slot that fits everyone; otherwise the slot with the most seats
            chosen = usable.find(s => s.seats === null || s.seats >= neededCount);
            if (!chosen) {
                chosen = usable.reduce((best, s) => (s.seats > best.seats ? s : best), usable[0]);
            }
            console.log('Slot mode: AUTO');
        } else {
            // PARTICULAR: only the slots listed in SLOT_PREFERENCES, in priority order
            console.log(`Slot mode: PARTICULAR (${SLOT_PREFERENCES.join(', ')})`);
            const norm = (t) => String(t).replace(/\s+/g, '');
            for (const wanted of SLOT_PREFERENCES) {
                const match = usable.find(s => norm(s.time) === norm(wanted));
                if (match) {
                    chosen = match;
                    break;
                }
                console.log(`ℹ️ Slot "${wanted}" is not available (missing or 0 seats).`);
            }
            if (!chosen) {
                console.log('⚠️ None of the preferred slots is available. Round will restart.');
                return { ok: false, availability: 0 };
            }
        }

        const target = slots.nth(chosen.index);
        if (await target.isVisible()) {
            slotStage = 'clicking the selected slot';
            await target.click();
            const availability = chosen.seats === null ? neededCount : chosen.seats;
            console.log(`✅ Selected slot ${chosen.time} (seats: ${chosen.seats === null ? 'unknown, assuming enough' : chosen.seats}).`);
            return { ok: true, availability };
        } else {
            console.log('⚠️ Route selected, but the chosen time slot is not visible.');
            return { ok: false, availability: 0 };
        }

    } catch (e) {
        const [slotCardCount, slotDetailCount] = await Promise.all([
            page.locator('.slot-media').count(),
            page.locator('.slot-dar-5').count(),
        ]);
        console.log(`Slot diagnostics: .slot-media=${slotCardCount}, .slot-dar-5=${slotDetailCount}`);
        console.log(`Slot API activity: ${slotApiDiagnostics.length ? slotApiDiagnostics.join(' | ') : 'no XHR/fetch responses observed'}`);
        console.log(`⚠️ Slot selection failed (${slotStage}): ${e.message.split('\n')[0]}`);
        return { ok: false, availability: 0 };
    }
}

const normalizeText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Selects the given pilgrim rows (original row numbers from PILGRIM_ROWS).
 * Each pilgrim is remembered by the text of its row, so if the list changes after
 * earlier pilgrims are booked, the right person is still found.
 * Returns the list of original row numbers that were actually ticked.
 */
async function selectPilgrims(page, rowsToSelect) {
    console.log('--- STARTING PILGRIM SELECTION ---');

    await page.waitForSelector('mat-row', { timeout: ACTION_TIMEOUT_MS });
    const rows = page.locator('mat-row');

    // Read the current list of row texts
    const readRowTexts = async () => {
        const n = await rows.count();
        const texts = [];
        for (let i = 0; i < n; i++) {
            texts.push(normalizeText(await rows.nth(i).innerText()));
        }
        return texts;
    };

    // First time on this page: remember who is in each configured row
    let currentTexts = await readRowTexts();
    for (const rowIndex of PILGRIM_ROWS) {
        if (!(rowIndex in pilgrimIdentity) && currentTexts[rowIndex - 1]) {
            pilgrimIdentity[rowIndex] = currentTexts[rowIndex - 1];
        }
    }

    const selectedRows = [];

    for (const originalRow of rowsToSelect) {
        // Find where this pilgrim is on the page right now
        let currentIndex = originalRow; // default: same row number
        const identity = pilgrimIdentity[originalRow];

        if (identity) {
            const found = currentTexts.findIndex(t => t === identity || t.includes(identity) || identity.includes(t));
            if (found === -1) {
                console.log(`⚠️ Pilgrim of original row ${originalRow} is not on the list now. Skipping.`);
                continue;
            }
            currentIndex = found + 1;
        }

        const checkboxSelector = `//mat-row[${currentIndex}]//mat-checkbox`;
        const inputSelector = `//mat-row[${currentIndex}]//mat-checkbox//input[@type="checkbox"]`;
        const checkbox = page.locator(checkboxSelector);
        const inputElement = page.locator(inputSelector);

        try {
            await inputElement.waitFor({ state: 'attached', timeout: 3000 });

            const isChecked = (await inputElement.getAttribute('aria-checked')) === 'true';

            if (!isChecked) {
                await checkbox.click();
                selectedRows.push(originalRow);
                console.log(`✅ Selected Pilgrim (original row ${originalRow}, currently row ${currentIndex})`);
            } else {
                console.log(`Pilgrim at row ${currentIndex} was already selected or unavailable.`);
            }

        } catch (e) {
            console.log(`⚠️ Pilgrim at row ${currentIndex} not available or failed to click. Error: ${e.message.split('\n')[0]}`);
        }
    }
    console.log(`Total pilgrims selected: ${selectedRows.length}`);
    return selectedRows;
}

/**
 * Fills the nominee table. The site shows one nominee row per selected pilgrim,
 * so this loops over every row on the page and fills each one with DEFAULT_NOMINEE
 * (or a per-row entry from NOMINEE_OVERRIDES). Works for any number of pilgrims.
 */
async function fillNominees(page) {
    console.log('--- STARTING NOMINEE DETAILS ---');

    const ROW_SELECTOR = '#nominee-table-wrapper tbody tr';
    const NAME_INPUT = 'input[placeholder="Enter Nominee Name"]';
    const AGE_INPUT = 'input[placeholder="Enter Age"]';

    // Wait for the first nominee row to appear
    await page.waitForSelector(`${ROW_SELECTOR} ${NAME_INPUT}`, { state: 'visible', timeout: ACTION_TIMEOUT_MS });

    // Rows can render one by one, so wait until the row count stops changing
    const rows = page.locator(ROW_SELECTOR);
    let rowCount = await rows.count();
    for (let attempt = 0; attempt < 10; attempt++) {
        await page.waitForTimeout(300);
        const current = await rows.count();
        if (current === rowCount) break;
        rowCount = current;
    }
    console.log(`Found ${rowCount} nominee row(s). Filling all of them.`);

    for (let i = 0; i < rowCount; i++) {
        const rowNumber = i + 1;
        const nominee = NOMINEE_OVERRIDES[rowNumber] || DEFAULT_NOMINEE;
        const row = rows.nth(i);

        const name = String(nominee.name).trim();
        const age = String(nominee.age).trim();
        const relationValue = RELATION_VALUES[String(nominee.relation).trim().toLowerCase()];

        // Validate against the site's own rules before typing
        if (!/^[a-zA-Z ]+$/.test(name) || name.length > 32) {
            console.log(`⚠️ Row ${rowNumber}: name "${name}" must be letters/spaces only, max 32 chars. Skipping this row.`);
            continue;
        }
        if (!/^[0-9]{1,3}$/.test(age)) {
            console.log(`⚠️ Row ${rowNumber}: age "${age}" must be 1 to 3 digits. Skipping this row.`);
            continue;
        }
        if (!relationValue) {
            console.log(`⚠️ Row ${rowNumber}: unknown relation "${nominee.relation}". Use: ${Object.keys(RELATION_VALUES).join(', ')}. Skipping this row.`);
            continue;
        }

        await row.scrollIntoViewIfNeeded();
        await row.locator(NAME_INPUT).fill(name);
        await row.locator(AGE_INPUT).fill(age);
        await row.locator('select').selectOption(relationValue);

        // Blur the last field so Angular marks the row as touched/valid
        await row.locator(AGE_INPUT).press('Tab');

        console.log(`✅ Row ${rowNumber} filled: ${name}, ${age}, ${nominee.relation}`);
    }

    console.log('--- ✅ NOMINEE DETAILS DONE ---');
}

/**
 * Selects "No" in both contribution sections:
 *   1. Contribute for Pilgrim Relief fund   (radio group name="contribute")
 *   2. Clean Sabarimala Project (Optional)  (radio group name="sanityYesOrNo")
 * Radio ids like #mat-radio-12 change between page loads, so we find each group by its
 * name and pick the "no" option inside it.
 */
async function selectContributionNo(page) {
    console.log('--- STARTING CONTRIBUTION OPTIONS ---');

    const groups = [
        { name: 'contribute', label: 'Pilgrim Relief fund', required: true },
        { name: 'sanityYesOrNo', label: 'Clean Sabarimala Project', required: false },
    ];

    for (const group of groups) {
        const noButton = page.locator(`mat-radio-group[name="${group.name}"] mat-radio-button[value="no"]`);

        try {
            await noButton.waitFor({ state: 'visible', timeout: group.required ? ACTION_TIMEOUT_MS : 5000 });
        } catch (e) {
            if (group.required) {
                throw new Error(`"${group.label}" contribution option not found on the page.`);
            }
            console.log(`ℹ️ "${group.label}" option not shown. Skipping.`);
            continue;
        }

        await noButton.scrollIntoViewIfNeeded();
        await noButton.locator('label').click();

        const cls = (await noButton.getAttribute('class')) || '';
        if (cls.includes('mat-radio-checked')) {
            console.log(`✅ Selected "No" for ${group.label}.`);
        } else {
            console.log(`⚠️ Clicked "No" for ${group.label}, but it does not look selected. Check the page.`);
        }
    }

    console.log('--- ✅ CONTRIBUTION OPTIONS DONE ---');
}

/**
 * Reads any validation message / toast / popup text currently on the page,
 * so the log shows WHY "Add to Wishlist" did not open the Proceed popup.
 */
async function pageProblemText(page) {
    try {
        const texts = await page.evaluate(() => {
            const selectors = [
                'mat-error', '.mat-error', '.error', '.text-danger', '.invalid-feedback',
                '.alert', '.toast', '.toast-message', '.snack-bar-container', 'simple-snack-bar',
                '.mat-snack-bar-container', '.swal2-popup', '.mat-dialog-container', '.modal-body',
                '.ng-invalid:not(form)'
            ];
            const out = [];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach((el) => {
                    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t) out.push(`${sel}: ${t.slice(0, 150)}`);
                    else if (sel === '.ng-invalid:not(form)') out.push(`invalid field: ${el.tagName.toLowerCase()}${el.getAttribute('placeholder') ? ' [' + el.getAttribute('placeholder') + ']' : ''}`);
                });
            }
            return out.slice(0, 8);
        });
        return texts.length ? texts.join(' || ') : 'no message found on page';
    } catch (e) {
        return 'could not read page messages';
    }
}

/**
 * Waits (up to SLOW_WAIT_MS) for a sign that the booking really went through.
 * Success = the page left the /darshan booking page, OR the URL matches
 * BOOKING_SUCCESS_URL_REGEX, OR the page text matches BOOKING_SUCCESS_TEXT_REGEX.
 * Returns true if confirmed, false if nothing confirmed it in time.
 */
async function verifyBookingSuccess(page) {
    console.log('--- VERIFYING BOOKING ---');
    const deadline = Date.now() + SLOW_WAIT_MS;
    let lastUrl = '';
    let lastText = '';

    while (Date.now() < deadline) {
        if (STOPPED) throw new Error('Stopped');

        lastUrl = page.url();
        lastText = normalizeText(await page.locator('body').innerText().catch(() => '')).slice(0, 300);

        const onLogin = /login|signin/i.test(lastUrl);
        const leftDarshan = !lastUrl.includes('/darshan') && !onLogin;
        const urlMatch = BOOKING_SUCCESS_URL_REGEX.test(lastUrl);
        const textMatch = BOOKING_SUCCESS_TEXT_REGEX.test(lastText);

        if (leftDarshan || urlMatch || textMatch) {
            const why = leftDarshan ? 'page left /darshan' : (urlMatch ? 'success URL matched' : 'success text matched');
            console.log(`Final page URL: ${lastUrl}`);
            console.log(`Final page text: ${lastText || 'could not read'}`);
            console.log(`✅ Booking confirmed (${why}).`);
            return true;
        }

        await page.waitForTimeout(1000);
    }

    console.log(`Final page URL: ${lastUrl}`);
    console.log(`Final page text: ${lastText || 'could not read'}`);
    console.log('⚠️ No booking confirmation was seen.');
    return false;
}

/**
 * Handles the wishlist and proceed steps, then CONFIRMS the booking.
 * Throws a normal error if anything is not confirmed, so the round restarts,
 * the wishlist is cleared, and the same pilgrims are tried again.
 */
async function handleFinalSteps(page) {
    console.log('--- STARTING FINAL CHECKOUT STEPS ---');

    const firstProceedButton = page.locator('button:visible:has-text("Proceed")').first();

    // ---- Phase 1: Add to Wishlist -> wait for the Proceed popup (retry the click if needed) ----
    let popupShown = false;
    for (let attempt = 1; attempt <= ADD_TO_WISHLIST_ATTEMPTS && !popupShown; attempt++) {
        if (STOPPED) throw new Error('Stopped');
        try {
            const addBtn = page.locator('button#regi_continue:has-text("Add to Wishlist")');
            await addBtn.scrollIntoViewIfNeeded();
            await addBtn.click({ timeout: ACTION_TIMEOUT_MS });
            console.log(`Clicked "Add to Wishlist" (attempt ${attempt}/${ADD_TO_WISHLIST_ATTEMPTS}).`);
        } catch (e) {
            console.log(`⚠️ Could not click "Add to Wishlist" (attempt ${attempt}): ${e.message.split('\n')[0]}`);
            continue;
        }

        try {
            await firstProceedButton.waitFor({ state: 'visible', timeout: 8000 });
            popupShown = true;
        } catch (e) {
            console.log(`⚠️ Proceed popup did not appear after attempt ${attempt}. Page says: ${await pageProblemText(page)}`);
            await page.waitForTimeout(1000);
        }
    }

    if (!popupShown) {
        const visibleButtons = (await page.locator('button:visible').allInnerTexts())
            .map((text) => text.trim())
            .filter(Boolean)
            .slice(0, 10);
        console.log(`Current URL: ${page.url()}`);
        console.log(`Visible buttons: ${visibleButtons.join(' | ') || 'none'}`);
        throw new Error('Add to Wishlist did not open the Proceed popup. Restarting the round.');
    }

    // ---- Phase 2: first Proceed -> payment page -> final Proceed ----
    try {
        await firstProceedButton.click();
        console.log('Clicked first "Proceed". Waiting for the payment page...');

        await page.waitForSelector('button#regi_continue:has-text("Proceed")', {
            state: 'visible',
            timeout: SLOW_WAIT_MS,
        });
        console.log('Payment page Proceed button is visible.');

        // Click the final "Proceed" button on the payment gateway
        await page.click('button#regi_continue:has-text("Proceed")');
        console.log('Clicked final "Proceed" button on Payment Gateway.');
    } catch (error) {
        const visibleButtons = (await page.locator('button:visible').allInnerTexts())
            .map((text) => text.trim())
            .filter(Boolean)
            .slice(0, 10);
        console.log(`Payment page Proceed button did not appear. Current URL: ${page.url()}`);
        console.log(`Visible buttons: ${visibleButtons.join(' | ') || 'none'}`);
        throw new Error(`Checkout did not reach the payment step: ${error.message.split('\n')[0]}`);
    }

    // ---- Phase 3: confirm the booking really happened ----
    await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    const confirmed = await verifyBookingSuccess(page);
    if (!confirmed) {
        throw new Error('Booking was not confirmed. These pilgrims stay in the remaining list and will be booked again.');
    }

    console.log('--- ✅ BOOKING CONFIRMED FOR THIS ROUND ---');
}

// -------------------------------------------------------------------------
// --- 4. EXECUTION ---
// -------------------------------------------------------------------------

let HEADLESS = true;
let USE_INSTALLED_CHROME = false;

/** Called by server.js. cfg comes from the UI. */
async function run(cfg, logFn) {
    LOG = logFn;
    STOPPED = false;
    USERNAME = cfg.username; PASSWORD = cfg.password;
    TARGET_DATES = cfg.dates;
    PILGRIM_ROWS = cfg.pilgrimRows;
    DEFAULT_NOMINEE = cfg.nominee;
    NOMINEE_OVERRIDES = cfg.overrides || {};
    ROUTE_VALUE = cfg.routeValue || '1';
    AUTO_SLOT_SELECTION = cfg.slotMode === 'auto' ? 1 : 0;
    SLOT_PREFERENCES = cfg.slots || [];
    MAX_CONSECUTIVE_FAILURES = cfg.maxFailures || 20;
    RETRY_DELAY_MS = (cfg.retryDelaySec || 5) * 1000;
    HEADLESS = cfg.headless !== false;
    USE_INSTALLED_CHROME = !!cfg.useInstalledChrome;
    await runBookingBot();
}

function stop() {
    STOPPED = true;
    if (activeBrowser) activeBrowser.close().catch(() => {});
}

module.exports = { run, stop };

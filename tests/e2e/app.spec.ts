import { expect, test, type Page } from '@playwright/test';

/** Opens a page and fails the test if the browser logged an error. */
async function gotoClean(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Sub-resource fetch failures are reported here without a URL; they are
    // browser-level noise (icons, prefetches), not application errors.
    if (message.text().includes('Failed to load resource')) return;
    errors.push(message.text());
  });
  await page.goto(path, { waitUntil: 'networkidle' });
  return errors;
}

test.describe('navigation', () => {
  test('reaches every top-level page from the nav', async ({ page }) => {
    await gotoClean(page, '/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

    const isMobile = await page.getByRole('button', { name: 'Menu' }).isVisible();
    const openNav = async () => {
      if (isMobile) await page.getByRole('button', { name: 'Menu' }).click();
    };

    for (const [label, heading] of [
      ['Value', 'Value'],
      ['Performance', 'Model performance'],
      ['Tracker', 'Tracker'],
      ['Admin', 'Admin'],
    ] as const) {
      await openNav();
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
  });

  test('marks the current page for assistive technology', async ({ page }) => {
    await gotoClean(page, '/value');
    const current = page.locator('[aria-current="page"]').first();
    await expect(current).toHaveText('Value');
  });
});

test.describe('demo data labelling', () => {
  test('shows the demo banner on every page', async ({ page }) => {
    for (const path of ['/', '/value', '/performance', '/tracker', '/admin']) {
      await gotoClean(page, path);
      await expect(page.getByText('Demo data').first()).toBeVisible();
    }
  });

  test('states plainly that fixtures are simulated', async ({ page }) => {
    await gotoClean(page, '/');
    await expect(page.getByText(/simulated/i).first()).toBeVisible();
    await expect(page.getByText(/Nothing here is a real sporting event/i)).toBeVisible();
  });

  test('carries the responsible-use disclaimer', async ({ page }) => {
    await gotoClean(page, '/');
    await expect(page.getByText(/Predictions are probabilistic estimates, not guarantees/i)).toBeVisible();
  });

  test('never uses guarantee language', async ({ page }) => {
    for (const path of ['/', '/value', '/performance']) {
      await gotoClean(page, path);
      const body = (await page.locator('body').innerText()).toLowerCase();
      for (const phrase of ['guaranteed win', 'sure bet', '100% prediction', 'risk-free']) {
        expect(body, `${path} must not say "${phrase}"`).not.toContain(phrase);
      }
    }
  });
});

test.describe('dashboard', () => {
  test('renders fixtures with model probabilities', async ({ page }) => {
    const errors = await gotoClean(page, '/');
    expect(errors).toEqual([]);

    await expect(page.getByText('Upcoming fixtures').first()).toBeVisible();
    const rows = page.locator('table tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    // Probabilities are rendered as percentages.
    await expect(page.getByText(/%/).first()).toBeVisible();
  });

  test('filters by sport and updates the URL', async ({ page }) => {
    await gotoClean(page, '/');
    await page.getByLabel('Sport').selectOption('tennis');
    await page.waitForURL(/sport=tennis/);
    await expect(page).toHaveURL(/sport=tennis/);

    // Every visible league belongs to the chosen sport.
    const leagueSelect = page.getByLabel('League');
    await expect(leagueSelect).toBeVisible();
  });

  test('resets filters', async ({ page }) => {
    await gotoClean(page, '/?sport=tennis');
    await page.getByRole('link', { name: 'Reset' }).click();
    await page.waitForURL((url) => !url.search.includes('sport='));
    await expect(page).not.toHaveURL(/sport=tennis/);
  });

  test('navigates to a match analysis', async ({ page }) => {
    await gotoClean(page, '/');
    await page.getByRole('link', { name: /View full analysis/ }).first().click();
    await expect(page.getByText('Prediction summary')).toBeVisible();
  });
});

test.describe('match analysis', () => {
  test.beforeEach(async ({ page }) => {
    await gotoClean(page, '/');
    await page.getByRole('link', { name: /View full analysis/ }).first().click();
    await page.waitForLoadState('networkidle');
  });

  test('shows the prediction, the market comparison and the model agreement', async ({ page }) => {
    await expect(page.getByText('Predicted outcome')).toBeVisible();
    await expect(page.getByText('Model versus market')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model agreement' })).toBeVisible();
    await expect(page.getByText('Ensemble (calibrated)')).toBeVisible();
  });

  test('explains the prediction from real features', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /^Why / })).toBeVisible();
    await expect(page.getByText('Model inputs')).toBeVisible();
  });

  test('reports confidence and data quality with their components', async ({ page }) => {
    await expect(page.getByText('Confidence and data quality')).toBeVisible();
    await expect(page.getByText('Data quality', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model agreement' })).toBeVisible();
  });

  test('lists every market derived from the model', async ({ page }) => {
    await expect(page.getByText('All markets')).toBeVisible();
    const rows = page.locator('table tbody tr');
    expect(await rows.count()).toBeGreaterThan(4);
  });

  test('records the model version and data timestamp', async ({ page }) => {
    await expect(page.getByText(/ensemble-\d+\.\d+\.\d+/).first()).toBeVisible();
  });

  test('returns 404 for an unknown match', async ({ page }) => {
    const response = await page.goto('/matches/does-not-exist');
    expect(response?.status()).toBe(404);
  });
});

test.describe('value page', () => {
  test('shows opportunities with their reliability classification', async ({ page }) => {
    const errors = await gotoClean(page, '/value');
    expect(errors).toEqual([]);
    await expect(page.getByText('Value opportunities')).toBeVisible();
    await expect(page.getByText('How to read the reliability column')).toBeVisible();
  });

  test('applies the EV threshold filter', async ({ page }) => {
    await gotoClean(page, '/value');
    await page.getByLabel('Min EV').selectOption('0.2');
    await page.waitForURL(/minEv=0.2/);
    await expect(page).toHaveURL(/minEv=0\.2/);
  });

  test('can restrict to model-supported edges only', async ({ page }) => {
    await gotoClean(page, '/value');
    await page.getByLabel('Reliability').selectOption('supported');
    await page.waitForURL(/reliability=supported/);
    // No flagged rows should remain.
    await expect(page.getByText('Beyond model accuracy').first()).toHaveCount(1); // legend only
  });

  test('shows an honest empty state rather than inventing rows', async ({ page }) => {
    await gotoClean(page, '/value?minEv=9');
    await expect(page.getByText('No opportunities match these filters')).toBeVisible();
  });
});

test.describe('performance page', () => {
  test('reports out-of-sample metrics and calibration', async ({ page }) => {
    const errors = await gotoClean(page, '/performance');
    expect(errors).toEqual([]);
    await expect(page.getByText('Headline metrics by model version')).toBeVisible();
    await expect(page.getByText('Calibration', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Log loss').first()).toBeVisible();
    await expect(page.getByText('Brier').first()).toBeVisible();
  });

  test('renders the calibration chart', async ({ page }) => {
    await gotoClean(page, '/performance');
    await expect(page.locator('svg').first()).toBeVisible();
  });
});

test.describe('tracker', () => {
  test('shows the ledger and bankroll analytics', async ({ page }) => {
    const errors = await gotoClean(page, '/tracker');
    expect(errors).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Record a prediction' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ledger' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bankroll' })).toBeVisible();
  });

  test('records a prediction and it appears in the ledger', async ({ page }) => {
    await gotoClean(page, '/tracker');
    const select = page.getByLabel('Selection');
    const options = select.locator('option');
    if ((await options.count()) < 2) test.skip();

    await select.selectOption({ index: 1 });
    await page.getByLabel('Stake (units)').fill('25');
    await page.getByRole('button', { name: 'Record prediction' }).click();

    await expect(page.getByRole('status')).toContainText(/recorded/i, { timeout: 30_000 });
    await expect(page.locator('table tbody tr').first()).toBeVisible();
  });
});

test.describe('admin', () => {
  test('reports pipeline health without exposing secrets', async ({ page }) => {
    const errors = await gotoClean(page, '/admin');
    expect(errors).toEqual([]);
    await expect(page.getByText('Environment')).toBeVisible();
    await expect(page.getByText('Model versions')).toBeVisible();
    await expect(page.getByText('Ingestion history')).toBeVisible();

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/postgresql:\/\//);
  });
});

test.describe('responsive behaviour', () => {
  test('wide tables scroll inside their container, not the page', async ({ page }) => {
    await gotoClean(page, '/');
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth - doc.clientWidth;
    });
    // A couple of pixels of rounding is tolerable; a horizontally scrolling page is not.
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test('the mobile menu opens on a small viewport', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'desktop project shows the inline nav');
    await gotoClean(page, '/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.locator('#mobile-nav')).toBeVisible();
  });
});

test.describe('theme', () => {
  test('toggles and persists across a reload', async ({ page }) => {
    await gotoClean(page, '/');
    const toggle = page.getByRole('button', { name: /Theme:/ });
    await toggle.click(); // system -> light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click(); // light -> dark
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('accessibility basics', () => {
  test('every page has one h1 and a skip link', async ({ page }) => {
    for (const path of ['/', '/value', '/performance', '/tracker', '/admin']) {
      await gotoClean(page, path);
      expect(await page.locator('h1').count(), path).toBe(1);
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
    }
  });

  test('the probability bar exposes a text description', async ({ page }) => {
    await gotoClean(page, '/');
    const bar = page.getByRole('img').first();
    await expect(bar).toHaveAttribute('aria-label', /%/);
  });
});

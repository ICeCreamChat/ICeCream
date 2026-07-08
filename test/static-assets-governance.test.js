import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('vendor manifest tracks offline assets and licenses', async () => {
    const manifest = JSON.parse(await readFile('public/vendor/manifest.json', 'utf8'));

    assert.equal(manifest.version, 1);
    assert.ok(Array.isArray(manifest.vendors));
    assert.ok(manifest.vendors.length > 0);

    for (const vendor of manifest.vendors) {
        assert.ok(vendor.name);
        assert.ok(vendor.source);
        assert.ok(vendor.license);
        const vendorInfo = await stat(vendor.path);
        assert.equal(vendorInfo.isDirectory(), true);
        if (vendor.path === 'public/vendor/geogebra') {
            const licenseInfo = await stat(path.join(vendor.path, 'LICENSE-GEOGEBRA.txt'));
            assert.equal(licenseInfo.isFile(), true);
        }
        if (vendor.path === 'public/vendor/pinyin-pro') {
            const licenseInfo = await stat(path.join(vendor.path, 'LICENSE'));
            assert.equal(licenseInfo.isFile(), true);
        }
    }
});

test('tracked generated bundles stay within declared size budgets', async () => {
    const manifest = JSON.parse(await readFile('public/vendor/manifest.json', 'utf8'));

    assert.ok(Array.isArray(manifest.generatedBundles));
    for (const bundle of manifest.generatedBundles) {
        assert.ok(bundle.command);
        assert.ok(bundle.source);
        const sourceInfo = await stat(bundle.source);
        assert.equal(sourceInfo.isFile(), true);

        const bundleInfo = await stat(bundle.path);
        assert.equal(bundleInfo.isFile(), true);
        assert.ok(
            bundleInfo.size <= bundle.maxSizeBytes,
            `${bundle.name} is ${bundleInfo.size} bytes, over ${bundle.maxSizeBytes}`
        );
    }
});

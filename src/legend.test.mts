import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const LEGEND_DIR = resolve(import.meta.dirname, '../assets/legend')
const LEGEND_COLORS = {
    accepted: '#2DA44E',
    review: '#D4A72C',
    missing: '#C94A4A',
}

function readLegend(name: string) {
    return readFileSync(resolve(LEGEND_DIR, `${name}.svg`), 'utf8')
}

test('legend assets are canonical solid, secure, and newline-stable SVGs', () => {
    assert.deepEqual(readdirSync(LEGEND_DIR).sort(), ['accepted.svg', 'missing.svg', 'review.svg'])
    for (const [name, color] of Object.entries(LEGEND_COLORS)) {
        const svg = readLegend(name)
        assert.match(svg, new RegExp(`fill="${color}"`, 'u'))
        assert.match(svg, /^<svg [^>]+><rect [^>]+\/><\/svg>\n$/u)
        assert.doesNotMatch(
            svg,
            /#E36300|pattern|gradient|<text|script|foreignObject|href=|src=|on\w+=|animation/u
        )
        assert.doesNotMatch(svg, /\r/u)
    }
})

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundPractice } from '../src/ai/ground.js';
import { looksLikeCode } from '../src/core/practice.js';

/**
 * Practice exercises.
 *
 *   node --test test/
 *
 * Two separate jobs are tested here, and they fail in different ways.
 *
 * `looksLikeCode` decides whether to spend a model call at all. Its failure
 * mode is cost, not correctness — a false positive wastes one request, a false
 * negative denies a student the feature. It errs towards yes for that reason.
 *
 * `groundPractice` decides what a student actually sees, and its failure mode
 * is a broken exercise: one whose tests call a function the starter never
 * defines can never pass, so the student debugs our bug instead of learning.
 * Everything that cannot be marked has to be dropped before it is shown.
 */

/**
 * A realistic slide count matters here. `buildIdf` weights a term by
 * log(n / (1 + df)), which degenerates when n is tiny: with two chunks every
 * term that appears anywhere scores at the 0.05 floor while every term that
 * does not scores 0.69, so a correct exercise is buried by its own task
 * wording. Twelve slides is the smallest fixture that behaves like a lecture.
 * Measured on this corpus, an exercise scores 0.37-0.68 against the slide it
 * cites and 0.000 against any other, which is the separation the threshold is
 * set for.
 */
const chunks = [
  'Binary search halves the search interval each step, so it runs in O(log n) time on a sorted array.',
  'A hash table maps a key to a bucket using a hash function, giving average constant time lookup.',
  'Linear search checks every element in turn and is O(n) in the worst case.',
  'A stack is last-in first-out. Push adds to the top and pop removes from the top.',
  'A queue is first-in first-out. Enqueue adds at the back and dequeue removes from the front.',
  'A linked list stores each element in a node that also holds a reference to the next node.',
  'Bubble sort repeatedly swaps adjacent elements that are out of order until no swaps remain.',
  'Merge sort divides the array in half, sorts each half, then merges the two sorted halves.',
  'Recursion solves a problem by calling itself on a smaller input until it reaches a base case.',
  'Big-O notation describes how the running time of an algorithm grows as the input grows.',
  'A binary tree gives each node at most two children, a left child and a right child.',
  'Depth-first traversal follows one branch to the end before backtracking to the next.',
].map((text, i) => ({ id: `c${i + 1}`, label: `Slide ${i + 1}`, text }));

const exercise = (over = {}) => ({
  id: 'e1',
  title: 'Write a binary search',
  concept: 'Binary search',
  language: 'python',
  entry: 'binary_search',
  brief: 'Return the index of target in a sorted array by halving the search interval, or -1.',
  starter: 'def binary_search(values, target):\n    pass\n',
  tests: [
    { call: 'binary_search([1, 3, 5], 5)', expect: '2' },
    { call: 'binary_search([1, 3, 5], 4)', expect: '-1' },
  ],
  hint: 'Keep two bounds and move the one that cannot contain the answer.',
  citations: ['c1'],
  ...over,
});

const ground = (over) => groundPractice({ exercises: [exercise(over)] }, chunks);

/* ------------------------------------------------------ what gets through */

test('a well-formed, grounded exercise survives intact', () => {
  const { practice, report } = ground();
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 0);

  const [e] = practice.exercises;
  assert.equal(e.entry, 'binary_search');
  assert.equal(e.language, 'python');
  assert.equal(e.tests.length, 2);
  assert.deepEqual(e.citations, ['c1']);
});

test('an unrecognised language falls back to python rather than reaching the runner', () => {
  // The worker only knows two languages. Passing "java" through would produce
  // an exercise that silently runs as JavaScript and fails every test.
  assert.equal(ground({ language: 'java' }).practice.exercises[0].language, 'python');
  assert.equal(ground({ language: undefined }).practice.exercises[0].language, 'python');
  assert.equal(ground({ language: 'javascript' }).practice.exercises[0].language, 'javascript');
});

/* ------------------------------------------------------- what gets dropped */

test('an entry point the starter never defines is dropped', () => {
  // Nothing would ever call it, so every test fails no matter what the student
  // writes. This is the single most expensive kind of broken exercise.
  const { practice, report } = ground({ entry: 'bsearch' });
  assert.equal(practice.exercises.length, 0);
  assert.equal(report.removed, 1);
});

test('tests that do not call the entry point are not tests', () => {
  const { practice } = ground({
    tests: [
      { call: 'sorted([3, 1])', expect: '[1, 3]' },
      { call: 'len([1, 2])', expect: '2' },
    ],
  });
  assert.equal(practice.exercises.length, 0);
});

test('fewer than two usable tests is not enough to mark an answer on', () => {
  assert.equal(ground({ tests: [{ call: 'binary_search([1], 1)', expect: '0' }] }).practice.exercises.length, 0);
  assert.equal(ground({ tests: [] }).practice.exercises.length, 0);
  // One good test and one with no expected value leaves one usable test.
  assert.equal(
    ground({ tests: [{ call: 'binary_search([1], 1)', expect: '0' }, { call: 'binary_search([1], 9)', expect: '' }] })
      .practice.exercises.length,
    0,
  );
});

test('an exercise citing a chunk that does not exist is dropped', () => {
  assert.equal(ground({ citations: ['c99'] }).practice.exercises.length, 0);
  assert.equal(ground({ citations: [] }).practice.exercises.length, 0);
});

test('an exercise citing a real chunk about something else is dropped', () => {
  // c2 is the hash-table slide. The citation resolves, so resolution alone
  // waves it through — only the overlap check catches a binary-search exercise
  // pointed at it. Same failure the recap grounding exists to catch.
  assert.equal(ground({ citations: ['c2'] }).practice.exercises.length, 0);
  // ...and the sort slides, to show it is not one lucky pairing.
  assert.equal(ground({ citations: ['c7'] }).practice.exercises.length, 0);
  assert.equal(ground({ citations: ['c8'] }).practice.exercises.length, 0);
});

test('missing title, brief or starter is dropped rather than rendered empty', () => {
  assert.equal(ground({ title: '' }).practice.exercises.length, 0);
  assert.equal(ground({ brief: '   ' }).practice.exercises.length, 0);
  assert.equal(ground({ starter: '' }).practice.exercises.length, 0);
});

test('an empty or malformed set is handled without throwing', () => {
  assert.deepEqual(groundPractice({ exercises: [] }, chunks).practice.exercises, []);
  assert.deepEqual(groundPractice({}, chunks).practice.exercises, []);
  assert.deepEqual(groundPractice(null, chunks).practice.exercises, []);
});

/* ------------------------------------------------------- the cheap pre-check */

test('prose that never mentions code does not spend a model call', () => {
  const history = [
    { id: 'c1', label: 'Slide 1', text: 'The Treaty of Versailles was signed in 1919 and imposed reparations on Germany.' },
    { id: 'c2', label: 'Slide 2', text: 'Economic hardship through the 1920s contributed to political instability across Europe.' },
  ];
  assert.equal(looksLikeCode(history), false);
  assert.equal(looksLikeCode([]), false);
  assert.equal(looksLikeCode(undefined), false);
});

test('a programming lecture is recognised whether or not it contains literal code', () => {
  assert.equal(looksLikeCode(chunks), true, 'complexity and data-structure vocabulary should count');

  // O(log n) is the most common complexity on an algorithms slide and was
  // missed by a pattern that only matched a leading n.
  assert.equal(
    looksLikeCode([
      { id: 'c1', label: 'Slide 1', text: 'Binary search runs in O(log n) time.' },
      { id: 'c2', label: 'Slide 2', text: 'Merge sort runs in O(n log n) time.' },
    ]),
    true,
  );

  assert.equal(
    looksLikeCode([
      { id: 'c1', label: 'Slide 1', text: 'def greet(name):\n    print("hello", name)' },
      { id: 'c2', label: 'Slide 2', text: 'for item in items:\n    total = total + item' },
    ]),
    true,
  );

  assert.equal(
    looksLikeCode([{ id: 'c1', label: 'Slide 1', text: 'SELECT name, dept FROM students WHERE year = 2;' }]),
    true,
  );
});

test('one incidental keyword in ordinary prose is not enough', () => {
  // "return" and "class" both appear here in their English senses, and neither
  // is a signal at all — words with everyday meanings are excluded outright.
  assert.equal(
    looksLikeCode([{ id: 'c1', label: 'Slide 1', text: 'Students return to class in September after the break.' }]),
    false,
  );

  // One weak signal on its own is below the threshold: a business lecture can
  // say "algorithm" without teaching anyone to write one.
  assert.equal(
    looksLikeCode([
      { id: 'c1', label: 'Slide 1', text: 'The recommendation algorithm decides which products a customer is shown.' },
      { id: 'c2', label: 'Slide 2', text: 'Personalisation raised basket size by eleven per cent in the trial.' },
    ]),
    false,
  );

  // But one unambiguous piece of syntax is enough on its own.
  assert.equal(
    looksLikeCode([{ id: 'c1', label: 'Slide 1', text: 'def total(items):\n    return sum(items)' }]),
    true,
  );
});

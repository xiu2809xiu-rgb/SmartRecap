/**
 * Seed material shipped with the app so the library, reader, quiz and analytics
 * screens have something to render before the user has uploaded anything.
 *
 * Everything here is flagged `sample: true` and renders behind a "Sample
 * material" badge — it is demonstration content, not a real user's data, and
 * the UI says so.
 *
 * The chunk list is the important part of the shape: every recap point and
 * every quiz question references chunk ids, and the reader refuses to render a
 * point whose citations do not resolve. That is the same contract the real
 * backend enforces in `backend/src/ai/ground.js`.
 */

export const SAMPLE_CHUNKS = [
  {
    id: 'c1',
    label: 'Slide 2',
    page: 2,
    text: 'Normalisation is the process of organising columns and tables in a relational database to reduce data redundancy and improve data integrity. Redundant data wastes storage and, more importantly, allows the same fact to be stored in two places where the copies can disagree.',
  },
  {
    id: 'c2',
    label: 'Slide 3',
    page: 3,
    text: 'Update anomaly: changing a fact requires updating many rows, and missing one leaves the database inconsistent. Insert anomaly: you cannot record a fact because unrelated data is missing. Delete anomaly: removing one row destroys unrelated information.',
  },
  {
    id: 'c3',
    label: 'Slide 5',
    page: 5,
    text: 'A functional dependency A -> B means the value of A uniquely determines the value of B. If StudentID -> StudentName, then knowing a StudentID is enough to know exactly one StudentName.',
  },
  {
    id: 'c4',
    label: 'Slide 7',
    page: 7,
    text: 'A primary key uniquely identifies each row in a table. It may be a single column or a composite of several columns. Primary keys cannot contain NULL and cannot repeat.',
  },
  {
    id: 'c5',
    label: 'Slide 8',
    page: 8,
    text: 'A foreign key is a column (or set of columns) that references a primary or candidate key in a related table. Foreign keys are what enforce referential integrity between tables.',
  },
  {
    id: 'c6',
    label: 'Slide 11',
    page: 11,
    text: 'First Normal Form (1NF) requires that every column holds a single atomic value and that there are no repeating groups. A column storing "Maths, Physics, Chemistry" violates 1NF.',
  },
  {
    id: 'c7',
    label: 'Slide 12',
    page: 12,
    text: 'Second Normal Form (2NF) requires 1NF plus the removal of partial dependencies: no non-key attribute may depend on only part of a composite primary key.',
  },
  {
    id: 'c8',
    label: 'Slide 13',
    page: 13,
    text: 'Third Normal Form (3NF) requires 2NF plus the removal of transitive dependencies: a non-key attribute must not depend on another non-key attribute. If StudentID -> DeptID and DeptID -> DeptName, then DeptName is transitively dependent and belongs in its own table.',
  },
  {
    id: 'c9',
    label: 'Slide 17',
    page: 17,
    text: 'INNER JOIN returns only rows with a match in both tables. LEFT JOIN returns every row from the left table plus matching rows from the right, filling NULL where no match exists. RIGHT JOIN is the mirror image. FULL OUTER JOIN returns unmatched rows from both sides.',
  },
  {
    id: 'c10',
    label: 'Slide 19',
    page: 19,
    text: 'CROSS JOIN produces the Cartesian product of two tables: every row of the first paired with every row of the second. A CROSS JOIN of a 1,000-row table with a 1,000-row table returns 1,000,000 rows.',
  },
  {
    id: 'c11',
    label: 'Slide 22',
    page: 22,
    text: 'Denormalisation deliberately reintroduces redundancy to reduce the number of joins a read query must perform. It trades write complexity and integrity risk for read speed, and should be a measured decision rather than a default.',
  },
];

const point = (id, text, citations, confidence = 'grounded') => ({ id, text, citations, confidence });

export const SAMPLE_RECAP = {
  summary:
    'Normalisation splits data so each fact lives in exactly one place, which removes the update, insert and delete anomalies that redundancy causes. You progress through 1NF (atomic values), 2NF (no partial dependencies) and 3NF (no transitive dependencies), using functional dependencies to decide where each attribute belongs. Joins are then how you put the split tables back together for a query.',
  readMinutes: 5,
  sections: [
    {
      id: 's1',
      heading: 'Why normalise at all',
      points: [
        point('p1', 'Normalisation organises tables and columns so that each fact is stored once, reducing redundancy and protecting data integrity.', ['c1']),
        point('p2', 'Redundancy is dangerous because duplicated copies of the same fact can disagree with one another.', ['c1']),
        point('p3', 'The three anomalies are the concrete cost: update anomalies leave the database inconsistent, insert anomalies block you from recording a fact, and delete anomalies destroy unrelated information.', ['c2']),
      ],
    },
    {
      id: 's2',
      heading: 'Functional dependencies and keys',
      points: [
        point('p4', 'A functional dependency is written A -> B and means that a value of A determines exactly one value of B.', ['c3']),
        point('p5', 'A primary key uniquely identifies a row, may be composite, and can never be NULL or repeated.', ['c4']),
        point('p6', 'A foreign key references a primary or candidate key in another table, and is the mechanism that enforces referential integrity.', ['c5']),
      ],
    },
    {
      id: 's3',
      heading: 'The three normal forms',
      points: [
        point('p7', '1NF: every column holds a single atomic value with no repeating groups — a column containing "Maths, Physics, Chemistry" fails this.', ['c6']),
        point('p8', '2NF: 1NF plus no partial dependencies, so no non-key attribute may depend on only part of a composite key.', ['c7']),
        point('p9', '3NF: 2NF plus no transitive dependencies — if StudentID determines DeptID and DeptID determines DeptName, DeptName belongs in its own table.', ['c8']),
      ],
    },
    {
      id: 's4',
      heading: 'Putting the tables back together',
      points: [
        point('p10', 'INNER JOIN keeps only matched rows; LEFT JOIN keeps every row on the left and pads the right with NULL where nothing matches.', ['c9']),
        point('p11', 'CROSS JOIN returns the Cartesian product — two 1,000-row tables produce 1,000,000 rows, which is almost never what you want by accident.', ['c10']),
        point(
          'p12',
          'Denormalisation reverses the process on purpose to cut join count on read-heavy queries, trading integrity risk for speed.',
          ['c11'],
        ),
      ],
    },
  ],
  keyTerms: [
    { term: 'Functional dependency', definition: 'A -> B: the value of A determines exactly one value of B.', citations: ['c3'] },
    { term: 'Partial dependency', definition: 'A non-key attribute depending on only part of a composite primary key. Removed at 2NF.', citations: ['c7'] },
    { term: 'Transitive dependency', definition: 'A non-key attribute depending on another non-key attribute. Removed at 3NF.', citations: ['c8'] },
    { term: 'Referential integrity', definition: 'The guarantee that every foreign key value matches an existing key in the referenced table.', citations: ['c5'] },
    { term: 'Denormalisation', definition: 'Deliberately reintroducing redundancy to reduce joins on read-heavy queries.', citations: ['c11'] },
  ],
  examTips: [
    'Be ready to name which anomaly a given scenario demonstrates — update, insert or delete. Questions usually describe the symptom rather than the term.',
    'When asked to normalise a table, write the functional dependencies out first. The normal form violations become obvious once the dependencies are on paper.',
    'A composite primary key is the signal to check for 2NF violations. A single-column key means partial dependencies are impossible.',
  ],
  ungrounded: [
    {
      text: 'INNER JOIN always outperforms LEFT JOIN on large tables.',
      reason: 'No slide in this deck makes a performance claim about join types, so this was dropped from the recap rather than presented as fact.',
    },
    {
      text: 'Boyce-Codd Normal Form (BCNF) is required for the exam.',
      reason: 'BCNF is not mentioned anywhere in the uploaded material. Check your module handbook if you think it should be in scope.',
    },
  ],
};

export const SAMPLE_QUIZ = {
  questions: [
    {
      id: 'q1',
      topic: 'Normalisation',
      difficulty: 1,
      prompt: 'What is the main purpose of database normalisation?',
      options: [
        'To make every query execute faster',
        'To reduce redundancy and prevent data anomalies',
        'To encrypt sensitive columns',
        'To combine all data into a single table',
      ],
      answer: 1,
      explanation: 'Normalisation gives each fact one reliable home. That reduces duplication and, with it, the update, insert and delete anomalies duplication causes.',
      citations: ['c1', 'c2'],
      verified: true,
    },
    {
      id: 'q2',
      topic: 'Keys',
      difficulty: 1,
      prompt: 'Which statement best describes a primary key?',
      options: [
        'It can contain duplicate values',
        'It links exactly two database servers',
        'It uniquely identifies each row in a table',
        'It must always be a single numeric column',
      ],
      answer: 2,
      explanation: 'A primary key uniquely identifies a row. It may be one column or a composite of several, and it can never be NULL or repeated.',
      citations: ['c4'],
      verified: true,
    },
    {
      id: 'q3',
      topic: 'Normal forms',
      difficulty: 2,
      prompt: 'A table is in Third Normal Form when it is in 2NF and additionally has...',
      options: ['no foreign keys', 'only numeric columns', 'no transitive dependencies', 'exactly three columns'],
      answer: 2,
      explanation: '3NF removes transitive dependencies: a non-key attribute must not depend on another non-key attribute.',
      citations: ['c8'],
      verified: true,
    },
    {
      id: 'q4',
      topic: 'Joins',
      difficulty: 2,
      prompt: 'Which join keeps every row from the left table even when no match exists on the right?',
      options: ['INNER JOIN', 'LEFT JOIN', 'CROSS JOIN', 'SELF JOIN'],
      answer: 1,
      explanation: 'LEFT JOIN returns all rows from the left table and the matching rows from the right, filling NULL where nothing matches.',
      citations: ['c9'],
      verified: true,
    },
    {
      id: 'q5',
      topic: 'Dependencies',
      difficulty: 1,
      prompt: 'If StudentID determines StudentName, how is that functional dependency written?',
      options: ['StudentName -> StudentID', 'StudentID = StudentName', 'StudentID -> StudentName', 'StudentID JOIN StudentName'],
      answer: 2,
      explanation: 'A -> B means the value of A uniquely determines the value of B, so it reads StudentID -> StudentName.',
      citations: ['c3'],
      verified: true,
    },
    {
      id: 'q6',
      topic: 'Joins',
      difficulty: 3,
      prompt: 'Two tables of 1,000 rows each are combined with CROSS JOIN. How many rows are returned?',
      options: ['1,000', '2,000', '1,000,000', 'It depends on the indexes'],
      answer: 2,
      explanation: 'CROSS JOIN produces the Cartesian product, so 1,000 x 1,000 = 1,000,000 rows.',
      citations: ['c10'],
      verified: true,
    },
    {
      id: 'q7',
      topic: 'Normal forms',
      difficulty: 2,
      prompt: 'What must be removed to move a table from 1NF to 2NF?',
      options: ['All primary keys', 'Partial dependencies on a composite key', 'Every foreign key', 'All text columns'],
      answer: 1,
      explanation: '2NF requires 1NF plus the removal of partial dependencies — non-key attributes depending on only part of a composite key.',
      citations: ['c7'],
      verified: true,
    },
    {
      id: 'q8',
      topic: 'Keys',
      difficulty: 2,
      prompt: 'What does a foreign key normally reference?',
      options: [
        'A primary or candidate key in a related table',
        'A file stored outside the database',
        'Another foreign key only',
        'The database administrator password',
      ],
      answer: 0,
      explanation: 'A foreign key references a unique key — usually the primary key — in a related table, which is how referential integrity is enforced.',
      citations: ['c5'],
      verified: true,
    },
    {
      id: 'q9',
      topic: 'Denormalisation',
      difficulty: 3,
      prompt: 'Why would a team deliberately denormalise a schema?',
      options: [
        'To satisfy 3NF more strictly',
        'To reduce the number of joins on read-heavy queries',
        'To remove the need for primary keys',
        'To guarantee referential integrity',
      ],
      answer: 1,
      explanation: 'Denormalisation reintroduces redundancy so reads touch fewer tables. The cost is write complexity and integrity risk, so it should be a measured decision.',
      citations: ['c11'],
      verified: true,
    },
    {
      id: 'q10',
      topic: 'Normal forms',
      difficulty: 1,
      prompt: 'A column stores the value "Maths, Physics, Chemistry". Which normal form does this break?',
      options: ['1NF', '2NF', '3NF', 'None — it is valid'],
      answer: 0,
      explanation: '1NF requires atomic values with no repeating groups. A comma-separated list in one column breaks it.',
      citations: ['c6'],
      verified: true,
    },
  ],
};

export const SAMPLE_MATERIAL = {
  id: 'sample-db-week5',
  sample: true,
  title: 'Database Systems — Week 5: Normalisation and Joins',
  fileName: 'DBS_Week5_Normalisation.pdf',
  fileType: 'pdf',
  sizeBytes: 2_418_332,
  module: 'Database Systems',
  mode: 'deep',
  status: 'ready',
  pageCount: 24,
  createdAt: '2026-08-17T09:12:00.000Z',
  chunks: SAMPLE_CHUNKS,
  recap: SAMPLE_RECAP,
  quiz: SAMPLE_QUIZ,
  provider: {
    name: 'OpenRouter',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    latencyMs: 18_420,
    tokensIn: 6_180,
    tokensOut: 2_240,
    costUsd: 0,
  },
};

export const SAMPLE_MATERIALS = [SAMPLE_MATERIAL];

from typing import Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, create_model, field_validator, model_validator


class Citation(BaseModel):
    label: str = Field(description="Human-readable locator, such as Slide 8 or Page 3")
    excerpt: str = Field(description="Short verbatim supporting excerpt from the source")
    source_id: str = Field(min_length=1, description="Stable ID of the supporting notebook source")
    source_name: str = Field(min_length=1, description="Filename of the supporting notebook source")


class Takeaway(BaseModel):
    text: str
    citation: Citation


class Definition(BaseModel):
    term: str
    meaning: str
    citation: Citation


class TopicSection(BaseModel):
    title: str
    explanation: str
    bullets: List[str] = Field(min_length=1, max_length=8)
    citation: Citation


class QuizQuestion(BaseModel):
    """Grounded question contract; absent ``type`` remains legacy single-select."""

    model_config = ConfigDict(populate_by_name=True)

    type: Literal["single", "multi", "short"] = "single"
    topic: str
    prompt: str
    options: List[str] = Field(default_factory=list, max_length=6)
    answer: Optional[Union[int, List[int]]] = None
    # No min_length: strict structured output forces a model to emit this key
    # even on a multiple-choice question, where "" is the only sensible value.
    # The blank is normalised to None in validate_type_contract, which still
    # refuses a short-answer question that has no real model answer.
    model_answer: Optional[str] = Field(default=None, max_length=2000, alias="modelAnswer")
    key_concepts: List[str] = Field(default_factory=list, max_length=8, alias="keyConcepts")
    rubric: Optional[str] = Field(default=None, max_length=1000)
    explanation: str
    verified: bool = True
    citation: Citation

    @model_validator(mode="after")
    def validate_type_contract(self):
        # Blank grading fields count as absent.
        #
        # OpenAI strict structured output requires every property to be present,
        # so a model has no way to omit modelAnswer or rubric on a
        # multiple-choice question -- it emits "" or an empty list. Those are
        # not short-answer grading fields, but the contract below read them as
        # such and rejected the entire quiz: "10 validation errors for
        # QuizPack" on a hard quiz, which is what made generation fail at
        # random. Normalising here keeps the rule itself strict; a short-answer
        # question with a blank model answer is still refused below.
        if isinstance(self.model_answer, str) and not self.model_answer.strip():
            self.model_answer = None
        if isinstance(self.rubric, str) and not self.rubric.strip():
            self.rubric = None
        self.key_concepts = [item for item in self.key_concepts if item and item.strip()]

        if self.type in {"single", "multi"}:
            if not 2 <= len(self.options) <= 6:
                raise ValueError("Objective questions require 2 to 6 options")
            if len({_normalized_text(item) for item in self.options}) != len(self.options):
                raise ValueError("Objective question options must be unique")
            if self.type == "single":
                if isinstance(self.answer, bool) or not isinstance(self.answer, int) or not 0 <= self.answer < len(self.options):
                    raise ValueError("Single-select answer must be one valid option index")
            else:
                if not isinstance(self.answer, list) or len(self.answer) < 2:
                    raise ValueError("Multi-select answer must contain at least two option indexes")
                if any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item < len(self.options) for item in self.answer):
                    raise ValueError("Multi-select answer contains an invalid option index")
                if len(set(self.answer)) != len(self.answer):
                    raise ValueError("Multi-select answer indexes must be unique")
                self.answer = sorted(self.answer)
            if self.model_answer is not None or self.key_concepts or self.rubric is not None:
                raise ValueError("Objective questions cannot include short-answer grading fields")
        else:
            if self.options or self.answer is not None:
                raise ValueError("Short-answer questions cannot include options or an objective answer")
            if not self.model_answer or not self.model_answer.strip():
                raise ValueError("Short-answer questions require modelAnswer")
            concepts = [item.strip() for item in self.key_concepts if item.strip()]
            concepts = list(dict.fromkeys(_normalized_text(item) for item in concepts))
            if not 1 <= len(concepts) <= 8:
                raise ValueError("Short-answer questions require 1 to 8 unique keyConcepts")
            self.key_concepts = concepts
            if not self.rubric or not self.rubric.strip():
                raise ValueError("Short-answer questions require a grading rubric")
        return self


def _normalized_text(value: str) -> str:
    return " ".join(str(value).casefold().split())


class QuizPack(BaseModel):
    questions: List[QuizQuestion] = Field(min_length=5, max_length=15)

    @field_validator("questions")
    @classmethod
    def ensure_unique_questions(cls, value: List[QuizQuestion]) -> List[QuizQuestion]:
        prompts = [item.prompt.strip().casefold() for item in value]
        if len(prompts) != len(set(prompts)):
            raise ValueError("Quiz questions must be unique")
        return value


class QuizGenerationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    difficulty: Literal["easy", "medium", "hard"]
    question_count: Literal[5, 10, 15] = Field(alias="questionCount")
    topics: List[str] = Field(default_factory=list, max_length=12)
    question_types: List[Literal["single", "multi", "short"]] = Field(default_factory=lambda: ["single"], alias="questionTypes")
    fresh: bool = False

    @field_validator("question_types")
    @classmethod
    def normalize_question_types(cls, value: List[str]) -> List[str]:
        if not value:
            return ["single"]
        return list(dict.fromkeys(value))

    @field_validator("topics")
    @classmethod
    def normalize_topics(cls, value: List[str]) -> List[str]:
        cleaned = [item.strip()[:80] for item in value if item.strip()]
        return list(dict.fromkeys(cleaned))


class IllustrationGenerationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    count: int = Field(default=2, ge=1, le=3)
    regenerate: bool = False


class MaterialAskRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, str_strip_whitespace=True)

    material_id: str = Field(min_length=1, max_length=128, alias="materialId")
    question: str = Field(min_length=3, max_length=1000)


class ChatIllustrationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    answer_id: str = Field(min_length=8, max_length=128, alias="answerId")


class StudyPack(BaseModel):
    title: str
    overview: str
    read_minutes: int = Field(ge=1, le=60)
    source_coverage: int = Field(ge=0, le=100)
    takeaways: List[Takeaway] = Field(min_length=3, max_length=12)
    definitions: List[Definition] = Field(min_length=2, max_length=16)
    topics: List[TopicSection] = Field(min_length=2, max_length=12)
    quiz: List[QuizQuestion] = Field(default_factory=list, max_length=15)
    warnings: List[str] = Field(default_factory=list)
    providers: List[Dict[str, str]] = Field(default_factory=list)

    @field_validator("quiz")
    @classmethod
    def ensure_unique_questions(cls, value: List[QuizQuestion]) -> List[QuizQuestion]:
        prompts = [item.prompt.strip().casefold() for item in value]
        if len(prompts) != len(set(prompts)):
            raise ValueError("Quiz questions must be unique")
        return value


# StudyPack as a provider is asked to produce it: without `providers` or `quiz`.
#
# `providers` is List[Dict[str, str]], and a free-form object carries no
# `required` key, which OpenAI strict structured output rejects outright --
# "Invalid schema for response_format 'StudyPack': 'required' is required to be
# supplied". It is why recaps could never be generated on an OpenAI-compatible
# provider while quizzes could: QuizPack has no such field. Provenance is
# something the application knows and a model does not, so asking for it was
# always wrong.
#
# `quiz` is dropped for a different reason. Strict mode requires every property
# to be present, so the model must emit model_answer and rubric on a
# multiple-choice question -- which QuizQuestion's own validator forbids as
# "Objective questions cannot include short-answer grading fields". The two
# rules cannot both be satisfied, and it made recap generation fail at random
# depending on how many objective questions the model happened to write.
#
# Nothing is lost: a material's quiz always comes from the quiz endpoint, and
# the recap's embedded questions were never shown to anyone.
_DRAFT_EXCLUDED = {"providers", "quiz"}

StudyPackDraft = create_model(
    "StudyPackDraft",
    **{
        name: (field.annotation, field)
        for name, field in StudyPack.model_fields.items()
        if name not in _DRAFT_EXCLUDED
    },
)


def to_study_pack(draft: "StudyPackDraft") -> StudyPack:
    return StudyPack(**draft.model_dump(), providers=[], quiz=[])


_ALLOWED_AVATAR_IDS = {
    # Current semantic IDs used by the React picker. Keep the legacy values so
    # older room/session payloads continue to load safely after this release.
    "nova", "orbit", "spark", "sage", "pixel", "comet",
    "default", "avatar-1", "avatar-2", "avatar-3", "avatar-4",
    "avatar-5", "avatar-6", "avatar-7", "avatar-8",
}


def _validate_avatar_id(value: str) -> str:
    avatar_id = str(value or "default").strip().casefold()
    if avatar_id not in _ALLOWED_AVATAR_IDS:
        raise ValueError("avatarId is not one of the supported avatars")
    return avatar_id


class LobbyCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=3, max_length=50)
    host_name: str = Field(min_length=2, max_length=24)
    material_id: str = Field(min_length=1, alias="materialId")
    quiz_id: str = Field(min_length=1, alias="quizId")
    max_players: int = Field(default=8, ge=2, le=20)
    # Not a Literal. The quiz editor stamps `difficulty: "manual"` on a
    # student-authored quiz, so a three-value enum rejected the whole lobby
    # with a 422 and the Create button just appeared to do nothing. This is a
    # label shown in the room header, not a control value — it does not need to
    # be closed, it needs to be bounded.
    difficulty: str = Field(default="Medium", max_length=24)
    visibility: Literal["public", "private"] = "public"
    password: Optional[str] = Field(default=None, min_length=4, max_length=64)
    question_count: int = Field(default=0, ge=0, le=50, alias="questionCount")
    avatar_id: str = Field(default="default", alias="avatarId")

    @field_validator("avatar_id")
    @classmethod
    def validate_avatar_id(cls, value: str) -> str:
        return _validate_avatar_id(value)

    @field_validator("password")
    @classmethod
    def normalize_password(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value else None


class LobbyJoin(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    player_name: str = Field(min_length=2, max_length=24, alias="playerName")
    password: Optional[str] = Field(default=None, max_length=64)
    avatar_id: str = Field(default="default", alias="avatarId")

    @field_validator("avatar_id")
    @classmethod
    def validate_avatar_id(cls, value: str) -> str:
        return _validate_avatar_id(value)


class Player(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    avatar_id: str = Field(default="default", alias="avatarId")
    score: int = 0
    ready: bool = False
    submitted: bool = False
    is_host: bool = False
    answered: int = 0
    correct: int = 0
    accuracy: float = 0.0
    last_correct: Optional[bool] = None


class Lobby(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    host_id: str
    material_id: str = Field(alias="materialId")
    quiz_id: str = Field(alias="quizId")
    max_players: int
    difficulty: str
    visibility: Literal["public", "private"] = "public"
    has_password: bool = False
    current_question: int = 0
    total_questions: int = 0
    status: str = "open"
    players: List[Player]
    created_at: str


class LobbySession(BaseModel):
    lobby: Lobby
    player_id: str
    reconnect_token: str


class HealthResponse(BaseModel):
    status: str
    ai_configured: bool
    demo_mode: bool
    extractors: List[str]


class LobbyAction(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    player_id: str = Field(min_length=4, max_length=64, alias="playerId")
    reconnect_token: str = Field(min_length=16, max_length=128, alias="reconnectToken")
    ready: bool = True


class LobbyAnswerAction(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    player_id: str = Field(min_length=4, max_length=64, alias="playerId")
    reconnect_token: str = Field(min_length=16, max_length=128, alias="reconnectToken")
    question_id: str = Field(min_length=1, max_length=128, alias="questionId")
    correct: bool
    response_ms: int = Field(ge=0, le=600_000, alias="responseMs")


class LobbyScoreAction(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    player_id: str = Field(min_length=4, max_length=64, alias="playerId")
    reconnect_token: str = Field(min_length=16, max_length=128, alias="reconnectToken")
    score: int = Field(ge=0, le=1_000_000)


class NotebookCreate(BaseModel):
    title: str = Field(min_length=3, max_length=100)
    mode: str = Field(default="cram", pattern="^(cram|deep)$")


class SourceRecord(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    text: str
    labels: List[str]
    status: str = "ready"
    warnings: List[str] = Field(default_factory=list)


class SourceSummary(BaseModel):
    id: str
    filename: str
    content_type: str
    size: int
    labels: List[str]
    status: str
    warnings: List[str]


class NotebookRecord(BaseModel):
    id: str
    title: str
    mode: str
    sources: List[SourceSummary] = Field(default_factory=list)
    latest_recap: Optional[StudyPack] = None
    created_at: str
    updated_at: str


class SourceBatchResponse(BaseModel):
    notebook: NotebookRecord
    added: List[SourceSummary]
    errors: List[str] = Field(default_factory=list)


class NotebookChatRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1000)


class NotebookChatResponse(BaseModel):
    answer: str
    citations: List[Citation] = Field(default_factory=list, max_length=8)
    grounded: bool = True

class PracticeTest(BaseModel):
    """One check on a student's answer.

    An expression and the value it should evaluate to, both written as source
    in the exercise's own language. Keeping them as source rather than as typed
    values means one runner checks Python and JavaScript identically and
    neither language needs a test framework shipped to the browser.
    """

    call: str = Field(min_length=1, description="A single expression calling the student's function")
    expect: str = Field(min_length=1, description="What that expression should evaluate to, written as source")


class PracticeExercise(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    concept: str = Field(default="General", description="Topic label taken from the material")
    language: Literal["python", "javascript"] = "python"
    entry: str = Field(min_length=1, description="Name of the function the student must write")
    brief: str = Field(min_length=1, description="One or two sentences saying what the function must do")
    starter: str = Field(min_length=1, description="Signature and docstring only — never the solution")
    tests: List[PracticeTest] = Field(min_length=2, max_length=4)
    hint: str = ""
    citations: List[Citation] = Field(default_factory=list, max_length=4)


class PracticeSet(BaseModel):
    """Exercises for a material, or an honest refusal.

    `applicable=False` is a complete and expected answer: most uploads are not
    programming material, and offering coding practice for a marketing deck
    would be worse than offering none.
    """

    applicable: bool = True
    reason: str = ""
    exercises: List[PracticeExercise] = Field(default_factory=list, max_length=4)

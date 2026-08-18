from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    topic: str
    prompt: str
    options: List[str] = Field(min_length=4, max_length=4)
    answer: int = Field(ge=0, le=3)
    explanation: str
    verified: bool = True
    citation: Citation


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
    fresh: bool = False

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

    @field_validator("quiz")
    @classmethod
    def ensure_unique_questions(cls, value: List[QuizQuestion]) -> List[QuizQuestion]:
        prompts = [item.prompt.strip().casefold() for item in value]
        if len(prompts) != len(set(prompts)):
            raise ValueError("Quiz questions must be unique")
        return value


class LobbyCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(min_length=3, max_length=50)
    host_name: str = Field(min_length=2, max_length=24)
    material_id: str = Field(min_length=1, alias="materialId")
    quiz_id: str = Field(min_length=1, alias="quizId")
    max_players: int = Field(default=8, ge=2, le=20)
    difficulty: Literal["Easy", "Medium", "Hard"] = "Medium"
    visibility: Literal["public", "private"] = "public"
    password: Optional[str] = Field(default=None, min_length=4, max_length=64)
    question_count: int = Field(default=0, ge=0, le=50, alias="questionCount")

    @field_validator("password")
    @classmethod
    def normalize_password(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value else None


class LobbyJoin(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    player_name: str = Field(min_length=2, max_length=24, alias="playerName")
    password: Optional[str] = Field(default=None, max_length=64)


class Player(BaseModel):
    id: str
    name: str
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
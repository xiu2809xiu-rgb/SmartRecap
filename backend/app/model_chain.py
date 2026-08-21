"""A list of candidate models that remembers what happened to each one.

Two services need the same thing and had each grown their own copy of it, both
built on a module-level global mutated through a `global` statement:

  * `code_service` keeps a chain of NVIDIA NIM models because they get retired
    without notice. Once one answers it should be used directly rather than
    walking the dead ones again on every request.
  * `image_service` keeps two Hugging Face routes. When one answers 402 the
    token has no credit for it, and asking again just burns a round trip.

Those are the same idea from opposite ends -- remember what worked, remember
what did not -- so they are one class here rather than two globals in two files.

Why a class and not a dict or a set: the remembering has an invariant that has
to hold across several call sites, and a bare container cannot enforce it. When
every candidate fails, the memory has to be cleared, or a provider that comes
back up stays skipped forever and the feature never recovers on its own. That
rule lives in `run` and in `forget`, so no caller can get it wrong by
forgetting to reset a flag.

Not thread-safe by design. The worst a race can do is send one extra request to
a model that was about to be skipped, which costs a round trip and nothing else
-- a lock here would be more machinery than the problem is worth.
"""

from __future__ import annotations

import logging
from typing import Callable, Iterable, Optional, Sequence, Tuple, TypeVar

logger = logging.getLogger("smartrecap.models")

T = TypeVar("T")


class ModelChain:
    """Candidates tried in order, with what happened to each remembered.

    >>> chain = ModelChain(["fast", "slow"], label="demo")
    >>> chain.candidates()
    ('fast', 'slow')
    >>> chain.remember_working("slow")
    >>> chain.candidates()          # the known-good one, on its own
    ('slow',)
    """

    def __init__(self, candidates: Iterable[str], *, label: str) -> None:
        self._candidates: Tuple[str, ...] = tuple(candidates)
        if not self._candidates:
            raise ValueError("A model chain needs at least one candidate.")
        self._label = label
        self._working: Optional[str] = None
        self._unavailable: set[str] = set()

    @property
    def label(self) -> str:
        return self._label

    def candidates(self) -> Tuple[str, ...]:
        """The models worth trying right now, best first.

        Once one is known to work it is the only one returned -- that is the
        whole point of remembering. Otherwise it is the original order minus
        anything known to be unavailable.
        """
        if self._working and self._working not in self._unavailable:
            return (self._working,)
        return tuple(c for c in self._candidates if c not in self._unavailable)

    def is_unavailable(self, candidate: str) -> bool:
        return candidate in self._unavailable

    def remember_working(self, candidate: str) -> None:
        self._working = candidate
        self._unavailable.discard(candidate)

    def mark_unavailable(self, candidate: str) -> None:
        """Skip this one from now on -- it is retired, or not paid for."""
        self._unavailable.add(candidate)
        if self._working == candidate:
            self._working = None

    def forget(self) -> None:
        """Drop everything remembered, so a recovered provider is tried again.

        Called when the whole chain fails. Without it a provider outage would
        be permanent from the app's point of view: every candidate would stay
        marked unavailable long after the provider came back.
        """
        self._working = None
        self._unavailable.clear()

    def run(self, attempt: Callable[[str], Optional[T]]) -> Optional[Tuple[str, T]]:
        """Call `attempt` with each candidate until one returns something.

        Returns `(candidate, result)`, or None when the whole chain is spent.
        A candidate that raises is logged and treated as a miss, because the
        point of a chain is that one provider being down is survivable.

        The bookkeeping is the reason to call this rather than looping by hand:
        a success is remembered, and total failure clears the memory so the
        next request starts from a clean slate.
        """
        for candidate in self.candidates():
            try:
                result = attempt(candidate)
            except Exception as exc:  # noqa: BLE001 - any provider error is a miss
                logger.warning("%s: %s unavailable: %s", self._label, candidate, str(exc)[:160])
                continue
            if result:
                self.remember_working(candidate)
                return candidate, result

        self.forget()
        return None

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "ModelChain({!r}, working={!r}, unavailable={!r})".format(
            self._label, self._working, sorted(self._unavailable)
        )


def as_chain(candidates: Sequence[str], *, label: str) -> ModelChain:
    """Small helper so callers read as one line at module scope."""
    return ModelChain(candidates, label=label)

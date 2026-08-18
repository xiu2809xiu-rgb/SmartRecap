import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Empty, Icon, Spinner, useToast } from '../components/ui.jsx';
import './forum.css';

const TYPES = {
  notes: { label: 'Notes', icon: 'description', prompt: 'Share a useful takeaway or study guide' },
  quiz: { label: 'Quiz', icon: 'quiz', prompt: 'Challenge the community with a quiz idea' },
  question: { label: 'Question', icon: 'help', prompt: 'Ask for help from other students' },
};

const FILTERS = [
  { value: 'all', label: 'All', icon: 'dynamic_feed' },
  { value: 'notes', label: 'Notes', icon: TYPES.notes.icon },
  { value: 'quiz', label: 'Quizzes', icon: TYPES.quiz.icon },
  { value: 'question', label: 'Questions', icon: TYPES.question.icon },
];

const emptyForm = { type: 'question', title: '', body: '', materialId: '' };
const asList = (value, keys = []) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
};

function errorMessage(error, fallback) {
  return error?.message || fallback;
}

function authorName(value, fallback = 'Student') {
  if (typeof value === 'string') return value;
  return value?.name || value?.displayName || value?.username || fallback;
}
function relativeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const [unit, size] = units.find(([, amount]) => seconds >= amount) || units.at(-1);
  const count = Math.floor(seconds / size);
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

function postAuthor(post) {
  return authorName(post.author, post.authorName || post.user?.name);
}

function postComments(post) {
  return asList(post.comments, ['items']);
}

function postLikes(post) {
  if (typeof post.likeCount === 'number') return post.likeCount;
  if (typeof post.likesCount === 'number') return post.likesCount;
  if (typeof post.likes === 'number') return post.likes;
  return Array.isArray(post.likes) ? post.likes.length : 0;
}

function isPostLiked(post, user) {
  if (typeof post.likedByMe === 'boolean') return post.likedByMe;
  if (typeof post.isLiked === 'boolean') return post.isLiked;
  if (!Array.isArray(post.likes) || !user) return false;
  return post.likes.some((like) => {
    const id = typeof like === 'string' ? like : like?.userId || like?.id;
    return id === user.id || id === user.email;
  });
}

export default function Forum() {
  const { user } = useAuth();
  const toast = useToast();
  const [posts, setPosts] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [filter, setFilter] = useState('all');
  const [form, setForm] = useState(emptyForm);
  const [comments, setComments] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [liking, setLiking] = useState({});
  const [commenting, setCommenting] = useState({});

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const [forumResult, materialResult] = await Promise.all([api.forum.list(), api.materials.list()]);
      setPosts(asList(forumResult, ['posts', 'items', 'data']));
      setMaterials(asList(materialResult, ['materials', 'items', 'data']));
    } catch (requestError) {
      setError(errorMessage(requestError, 'The community could not be loaded.'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const materialMap = useMemo(() => new Map(materials.map((material) => [String(material.id), material])), [materials]);
  const visiblePosts = useMemo(
    () => posts.filter((post) => filter === 'all' || post.type === filter),
    [filter, posts],
  );

  const updatePost = (id, result) => {
    const updated = result?.post || result;
    if (!updated?.id || String(updated.id) !== String(id)) return false;
    setPosts((current) => current.map((post) => (String(post.id) === String(id) ? updated : post)));
    return true;
  };

  const createPost = async (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;
    setCreating(true);
    try {
      const payload = {
        type: form.type,
        title: form.title.trim(),
        body: form.body.trim(),
        ...(form.materialId ? { materialId: form.materialId } : {}),
      };
      const result = await api.forum.create(payload);
      const created = result?.post || result;
      if (created?.id) setPosts((current) => [created, ...current]);
      else await load({ quiet: true });
      setForm(emptyForm);
      setFilter('all');
      toast.success('Your post is live.');
    } catch (requestError) {
      toast.error(errorMessage(requestError, 'Could not publish your post.'));
    } finally {
      setCreating(false);
    }
  };
  const likePost = async (post) => {
    const id = post.id;
    if (liking[id]) return;
    setLiking((current) => ({ ...current, [id]: true }));
    try {
      const result = await api.forum.like(id);
      if (!updatePost(id, result)) await load({ quiet: true });
    } catch (requestError) {
      toast.error(errorMessage(requestError, 'Could not update this like.'));
    } finally {
      setLiking((current) => ({ ...current, [id]: false }));
    }
  };

  const addComment = async (event, post) => {
    event.preventDefault();
    const id = post.id;
    const body = (comments[id] || '').trim();
    if (!body || commenting[id]) return;
    setCommenting((current) => ({ ...current, [id]: true }));
    try {
      const result = await api.forum.comment(id, { body });
      if (!updatePost(id, result)) await load({ quiet: true });
      setComments((current) => ({ ...current, [id]: '' }));
      toast.success('Comment added.');
    } catch (requestError) {
      toast.error(errorMessage(requestError, 'Could not add your comment.'));
    } finally {
      setCommenting((current) => ({ ...current, [id]: false }));
    }
  };

  return (
    <div className="shell forum-page">
      <header className="forum-hero">
        <div>
          <p className="eyebrow">Student community</p>
          <h1>Learn better, together.</h1>
          <p className="lede">Trade notes, test each other, and get unstuck with students working through the same material.</p>
        </div>
        <div className="forum-hero-mark" aria-hidden="true">
          <Icon name="diversity_3" size={34} />
        </div>
      </header>

      <div className="forum-layout">
        <aside className="forum-compose panel" aria-label="Create a community post">
          <div className="forum-compose-head">
            <span className="forum-avatar">{(user?.name || '?').slice(0, 1).toUpperCase()}</span>
            <div>
              <h2>Share with the community</h2>
              <p>Posting as {user?.name || 'Student'}</p>
            </div>
          </div>

          <form onSubmit={createPost} className="forum-form">
            <fieldset className="forum-types">
              <legend>Post type</legend>
              {Object.entries(TYPES).map(([value, option]) => (
                <label key={value} className={form.type === value ? 'is-on' : ''}>
                  <input
                    type="radio"
                    name="post-type"
                    value={value}
                    checked={form.type === value}
                    onChange={() => setForm((current) => ({ ...current, type: value }))}
                  />
                  <Icon name={option.icon} size={18} />
                  {option.label}
                </label>
              ))}
            </fieldset>

            <label className="field forum-field">
              <span>Title</span>
              <input
                className="input"
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder={TYPES[form.type].prompt}
                maxLength={120}
                required
              />
            </label>
            <label className="field forum-field">
              <span>What would you like to share?</span>
              <textarea
                className="input forum-textarea"
                value={form.body}
                onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
                placeholder="Add context, explain your thinking, or ask a clear question…"
                maxLength={4000}
                rows={6}
                required
              />
            </label>
            <label className="field forum-field">
              <span>Link a material <em>optional</em></span>
              <select
                className="input"
                value={form.materialId}
                onChange={(event) => setForm((current) => ({ ...current, materialId: event.target.value }))}
              >
                <option value="">No linked material</option>
                {materials.map((material) => <option key={material.id} value={material.id}>{material.title}</option>)}
              </select>
            </label>
            <div className="forum-publish-row">
              <span>{form.body.length.toLocaleString()} / 4,000</span>
              <button className="btn btn-primary" disabled={creating || !form.title.trim() || !form.body.trim()}>
                {creating ? <Spinner size={17} label="Publishing post" /> : <Icon name="send" size={17} />}
                {creating ? 'Publishing…' : 'Publish post'}
              </button>
            </div>
          </form>
        </aside>
        <main className="forum-feed">
          <div className="forum-feed-bar">
            <div>
              <h2>Community feed</h2>
              <p>{posts.length} {posts.length === 1 ? 'post' : 'posts'} shared</p>
            </div>
            <div className="forum-filters" role="radiogroup" aria-label="Filter community posts">
              {FILTERS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  role="radio"
                  aria-checked={filter === option.value}
                  className={filter === option.value ? 'is-on' : ''}
                  onClick={() => setFilter(option.value)}
                >
                  <Icon name={option.icon} size={17} />
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="forum-state panel" role="status">
              <Spinner size={24} />
              <span>Loading the community…</span>
            </div>
          ) : error ? (
            <div className="forum-state panel">
              <Empty
                icon="cloud_off"
                title="The community is out of reach"
                body={error}
                action={<button type="button" className="btn btn-primary btn-sm" onClick={() => load()}>Try again</button>}
              />
            </div>
          ) : visiblePosts.length === 0 ? (
            <div className="forum-state panel">
              <Empty
                icon={filter === 'all' ? 'forum' : TYPES[filter]?.icon}
                title={filter === 'all' ? 'Start the conversation' : `No ${FILTERS.find((item) => item.value === filter)?.label.toLowerCase()} yet`}
                body={filter === 'all' ? 'Share the first note, quiz, or question with your study community.' : 'Choose another filter or publish one yourself.'}
              />
            </div>
          ) : (
            <div className="forum-posts">
              {visiblePosts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  user={user}
                  material={
                    post.material ||
                    (post.materialId
                      ? materialMap.get(String(post.materialId)) || {
                          id: post.materialId,
                          title: post.materialTitle || 'Study material',
                        }
                      : null)
                  }
                  commentValue={comments[post.id] || ''}
                  onCommentChange={(value) => setComments((current) => ({ ...current, [post.id]: value }))}
                  onComment={(event) => addComment(event, post)}
                  onLike={() => likePost(post)}
                  isLiking={!!liking[post.id]}
                  isCommenting={!!commenting[post.id]}
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function PostCard({ post, user, material, commentValue, onCommentChange, onComment, onLike, isLiking, isCommenting }) {
  const type = TYPES[post.type] || TYPES.question;
  const comments = postComments(post);
  const commentCount = typeof post.commentCount === 'number' ? post.commentCount : comments.length;
  const liked = isPostLiked(post, user);
  const name = postAuthor(post);

  return (
    <article className={`forum-post panel forum-post-${post.type || 'question'}`}>
      <header className="forum-post-head">
        <span className="forum-avatar forum-avatar-small">{name.slice(0, 1).toUpperCase()}</span>
        <div className="grow">
          <strong>{name}</strong>
          <p><time dateTime={post.createdAt}>{relativeTime(post.createdAt)}</time>{post.editedAt ? ' · edited' : ''}</p>
        </div>
        <span className={`forum-type forum-type-${post.type || 'question'}`}>
          <Icon name={type.icon} size={16} />{type.label}
        </span>
      </header>

      <div className="forum-post-body">
        <h3>{post.title}</h3>
        <p>{post.body}</p>
      </div>

      {material && (
        <Link className="forum-material" to={`/app/material/${material.id || post.materialId}`}>
          <span><Icon name="menu_book" size={18} /></span>
          <div className="grow truncate">
            <small>Linked material</small>
            <strong className="truncate">{material.title || material.name || 'Study material'}</strong>
          </div>
          <Icon name="arrow_forward" size={17} />
        </Link>
      )}

      <div className="forum-actions">
        <button type="button" className={liked ? 'is-liked' : ''} onClick={onLike} disabled={isLiking} aria-pressed={liked}>
          {isLiking ? <Spinner size={17} label="Updating like" /> : <Icon name="favorite" size={18} fill={liked} />}
          <span>{postLikes(post)} {postLikes(post) === 1 ? 'like' : 'likes'}</span>
        </button>
        <span><Icon name="mode_comment" size={18} />{commentCount} {commentCount === 1 ? 'comment' : 'comments'}</span>
      </div>

      <section className="forum-comments" aria-label={`Comments on ${post.title}`}>
        {comments.map((comment, index) => {
          const commentName = authorName(comment.author, comment.authorName || comment.user?.name);
          const commentBody = typeof comment === 'string' ? comment : comment.body || comment.text;
          return (
            <div className="forum-comment" key={comment.id || `${post.id}-comment-${index}`}>
              <span className="forum-avatar forum-avatar-comment">{commentName.slice(0, 1).toUpperCase()}</span>
              <div>
                <p><strong>{commentName}</strong><time dateTime={comment.createdAt}>{relativeTime(comment.createdAt)}</time></p>
                <span>{commentBody}</span>
              </div>
            </div>
          );
        })}
        <form className="forum-comment-form" onSubmit={onComment}>
          <span className="forum-avatar forum-avatar-comment">{(user?.name || '?').slice(0, 1).toUpperCase()}</span>
          <label className="grow">
            <span className="sr-only">Add a comment</span>
            <input
              value={commentValue}
              onChange={(event) => onCommentChange(event.target.value)}
              placeholder="Add a helpful comment…"
              maxLength={1000}
              disabled={isCommenting}
            />
          </label>
          <button type="submit" disabled={isCommenting || !commentValue.trim()} aria-label="Post comment">
            {isCommenting ? <Spinner size={17} label="Posting comment" /> : <Icon name="send" size={18} />}
          </button>
        </form>
      </section>
    </article>
  );
}

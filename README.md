# AIC-RETRIEVAL UI v1

UI tối giản theo layout 1/3 + 2/3:

- Trái: API Server + health, Chat/Query.
- Phải: candidate image grid 6–7 ảnh/hàng.
- Auto-route KIS / TRAKE / QA từ prefix/title query BTC.
- Greeting local (`hi`, `hello`, `xin chào`...) không gọi backend.
- Chat command kiểm tra health (`server còn sống không`, `health`, `check server`...).
- Enter = search; Shift+Enter = newline; input tự xóa sau khi gửi.
- Candidate click lần 1 = select + mở metadata; click lần 2 = zoom.
- Lightbox: nút ‹/›, phím ←/→, wheel zoom, kéo ảnh khi zoom, Esc đóng.
- Preview dùng `POST /preview` với `video_id + pts_time`.
- Search dùng `POST /search` với `{task_type, query}`.
- Khi backend trả 401, UI hỏi Bearer token một lần và chỉ giữ trong memory của tab.
- R@K chỉ tính khi có GT/relevance label hoặc backend metric; không suy ra từ similarity score.

## Query examples

```text
trake-query-01 (02:55)
Đây là một cảnh nấu món cá. E1: ... E2: ...
```

```text
KIS: a man holding a red bag
```

```text
QA: Người đàn ông đang cầm vật gì?
```

## Deploy

Đưa `index.html`, `styles.css`, `app.js` lên GitHub Pages.
Có thể truyền API URL:

```text
https://<github-pages>/?api=https%3A%2F%2Fxxxxx.trycloudflare.com
```


## v1.1 — BTC official scoring correction

- Replaced generic Recall@K with BTC Mean of Top-k R-Scores.
- Fixed thresholds to {1, 5, 20, 50, 100}.
- `R@k = max R-Score(r_i)` over the first k submitted answers.
- `Final = mean(R@1, R@5, R@20, R@50, R@100)`.
- Never derives BTC R-Score from cosine/similarity. Uses explicit backend official metric / r_score only.
- Candidate metadata may contain up to 100 records, but previews are lazy-loaded with IntersectionObserver and max 4 concurrent `/preview` calls.
- Search body sends `top_k: 100` for forward compatibility. Current v0.5.5 backend is still server-limited to 20 and must be upgraded separately.

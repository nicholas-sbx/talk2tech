"""Streamlit analytics: which objects people talk to, and what they say.

Run from the repo root:  streamlit run dashboard/app.py
"""

import json
import sys
from pathlib import Path

import pandas as pd
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from integrations import config  # noqa: E402

st.set_page_config(page_title="talk2tech dashboard", page_icon="🗣️", layout="wide")


@st.cache_data(ttl=10)
def load_events() -> tuple[pd.DataFrame, str]:
    if config.use_snowflake():
        import snowflake.connector

        params = {k: v for k, v in config.SNOWFLAKE.items() if v}
        with snowflake.connector.connect(**params) as conn:
            df = pd.read_sql("SELECT TS, SESSION_ID, KIND, OBJECT_NAME, PAYLOAD FROM EVENTS", conn)
        df.columns = [c.lower() for c in df.columns]
        df["payload"] = df["payload"].apply(lambda p: json.loads(p) if isinstance(p, str) else p)
        return df, "Snowflake"

    path = config.LOCAL_EVENTS_PATH
    if not path.exists():
        return pd.DataFrame(columns=["ts", "session_id", "kind", "object_name", "payload"]), str(path)
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return pd.DataFrame(rows), str(path)


df, source = load_events()
st.title("talk2tech")
st.caption(f"Source: {source}")

if df.empty:
    st.info("No conversations yet. Go talk to something!")
    st.stop()

df["ts"] = pd.to_datetime(df["ts"])
objects = df[df["kind"] == "object"]
turns = df[df["kind"] == "turn"]

c1, c2, c3 = st.columns(3)
c1.metric("Objects awakened", len(objects))
c2.metric("Conversation turns", len(turns))
c3.metric("Sessions", df["session_id"].nunique())

st.subheader("Most talked-to objects")
st.bar_chart(turns["object_name"].value_counts().head(10))

st.subheader("Recent conversation")
recent = turns.sort_values("ts", ascending=False).head(25)
st.dataframe(
    pd.DataFrame(
        {
            "time": recent["ts"],
            "object": recent["object_name"],
            "user": recent["payload"].map(lambda p: p.get("user")),
            "reply": recent["payload"].map(lambda p: p.get("reply")),
        }
    ),
    hide_index=True,
    use_container_width=True,
)

st.subheader("Personas")
st.dataframe(pd.DataFrame(list(objects["payload"])), hide_index=True, use_container_width=True)

from pydantic import BaseModel, Field


class RenderRequest(BaseModel):
    code: str = Field(min_length=1, max_length=60000)
    client_id: str = Field(default="gateway", max_length=80)


class SuggestionRequest(BaseModel):
    code: str
    count: int = 5


using System.Collections.Generic;
using UnityEngine;

public class JugglingPatternMetrics : MonoBehaviour
{
    public JugglingInputHandler inputHandler;

    // Exposed properties
    public float LastT { get; private set; }
    public float LastW { get; private set; }
    public float LastH { get; private set; }

    class BallData
    {
        public float lastCatchTime;
        public float lastThrowTime;
        public float nextCatchTime;
        public float nextThrowTime;

        public bool inFlight;
        public float startHeight;
        public float maxHeight;
        public bool hasCatch;
    }

    private Dictionary<GameObject, BallData> ballData = new Dictionary<GameObject, BallData>();

    void OnEnable()
    {
        if (inputHandler != null)
        {
            inputHandler.OnBallThrow += HandleBallThrow;
            inputHandler.OnBallCatch += HandleBallCatch;
        }
    }

    void OnDisable()
    {
        if (inputHandler != null)
        {
            inputHandler.OnBallThrow -= HandleBallThrow;
            inputHandler.OnBallCatch -= HandleBallCatch;
        }
    }

    void Update()
    {
        foreach (var kvp in ballData)
        {
            var ball = kvp.Key;
            var data = kvp.Value;
            if (data.inFlight)
            {
                float y = ball.transform.position.y;
                if (y > data.maxHeight)
                    data.maxHeight = y;
            }
        }
    }

    private BallData GetData(GameObject ball)
    {
        if (!ballData.TryGetValue(ball, out var data))
        {
            data = new BallData();
            ballData[ball] = data;
        }
        return data;
    }

    private void HandleBallThrow(GameObject ball)
    {
        var data = GetData(ball);
        float time = Time.time;

        if (data.hasCatch)
        {
            // Complete previous cycle if possible
            if (data.nextCatchTime > 0f)
            {
                data.nextThrowTime = time;

                float d = data.lastThrowTime - data.lastCatchTime;
                float f = data.nextCatchTime - data.lastThrowTime;
                float e = data.nextCatchTime - data.nextThrowTime;
                float T = d + e;
                float W = T != 0f ? f / T : 0f;

                LastT = T;
                LastW = W;
                LastH = data.maxHeight - data.startHeight;

                Debug.Log($"T: {T} W: {W}");
            }
        }

        // Start new throw
        data.lastThrowTime = time;
        data.inFlight = true;
        data.startHeight = ball.transform.position.y;
        data.maxHeight = data.startHeight;
        data.nextCatchTime = 0f;
        data.hasCatch = false;
    }

    private void HandleBallCatch(GameObject ball)
    {
        var data = GetData(ball);
        float time = Time.time;

        data.nextCatchTime = time;
        data.inFlight = false;
        data.lastCatchTime = data.lastCatchTime == 0f ? time : data.lastCatchTime;
        data.hasCatch = true;
    }
}

